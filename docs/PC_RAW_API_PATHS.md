# 既存PC APIと現FWのraw取得経路

**FW変更が必須とはまだ断定できません。** 公式PC raw APIは同梱されていますが、現在のアプリはそれを使った実機ADC取得をまだ実装・検証していません。CSKから取得できているのはFW処理後の検出イベントです。今回の再確認は保存済み情報、静的解析、完全mockのみで、新たな実機接続・設定・収録・driver導入・FW書込みはしていません。

## 経路ごとの条件

|経路|確認できたこと|現在使えるか／不足する根拠|
|---|---|---|
|公式PC API: DeviceSmartar / FrameReaderSmartar|ADC frame APIとBGT60CUTR13B識別が実装されている。Strata探索は`serial,udp,uvc,libusb`で、USB専用ではない|現dev FWがStrata board protocolと必要interfacesを提供するか未確認。以前の探索0件だけでは非対応としない。constructor/openのreset・設定等を無断で実行しない|
|公式PC API: DeviceFmcw / C SDK|Pythonのget_list・port指定constructor・get_next_frameと、DLLのraw-frame C exportsが存在|この経路の実機探索・接続は未実施。SDK baseの埋込version文字列は3.6.4。Python RadarSensor enumにはCUTR名がなく、nativeのB-step／現CSK FW互換と初期化の副作用は未確認。exportの存在は対応保証ではない|
|現dev FWのUART/USBを独自受信|保全済みFWの既知UART dispatcher、設定GET/SET、既存の検出イベントを確認|既知経路でADC送出・enable方法を確認できていない。隠れた別出力の不存在も証明していない。PC受信器が未実装であることと、FWに送出機能がないことを区別する|
|MCU内FIFO＋送信機能追加|公開driverにFIFO APIがあり、独自producer候補はbuild済み|PC SDKとは別のMCU側処理。独自FWなら現FWを置換する。boot・raw取得・復元書込みは未試験で、既存APIの条件確認を優先する|
|配線／機材変更|WingのSPI/IRQ接続を公式資料で確認できる|KitProg3 USB-SPI interfaceの存在だけでWing直結を意味しない。pin、bus所有、電圧、IRQ、対応FWを確認する必要がある。MCU7も自動的な代替とはしない。購入・配線変更は未実施|

Strata側はboardから`IRadarSmartar`、`IRegisters`、`IData`、`IBridgeData`を使う。COM番号やUSB VID/PIDだけでこのprotocol/interface条件を満たすとはいえない。native binaryにはboard protocol versionの互換検査を示す情報があるが、現dev FWとの互換versionは未確認。

## 同梱APIの根拠

インストール版はVisualization Tool **1.1.0**、ReleaseNotes.txtの日付は2026-06-19。次表の番号は`.pyc`に残る**元Python sourceの行対応**（co_firstlineno / line table）であり、実在する`.py`本文や`.pyc`のテキスト行を引用したものではない。メーカーcodeは配布しない。

|インストール先からの相対path|関数と元source行対応|確認内容|
|---|---|---|
|`lib/ifxapp/hardware_access/event_readers/smartar_motion_detector_bstep/device_smartar.pyc`|`_getBoards`798、804–821|4 backendで探索し、0件の例外はsensor/UUID filterより前。board作成後にcomponent・ID_HW・UUIDを読む。native board作成自体の全副作用は未確認|
|同上|`__init__`123、215–225|reset、SEQ_BUFFER書込み、取得stopを含む。それらをすべて省くconstructor引数はない|
|同上|`configureAcquisition`336、`startAcquisition`471、`takeFrame`523|FIFO設定、stream開始、uint8 frame取得。reshape前bytesを保持できる入口だが、実機では未使用|
|`lib/ifxapp/hardware_access/frame_readers/frame_reader_smartar.pyc`|`open`43、49–72|map指定時の書込み、ADC校正、取得設定、start、trigger。map=Noneでも校正/start/triggerを省けない|
|同上|`__next__`91、102、`_reshape_data`108–130|timestampはPCのtime.time()。uint16をreshape後float32/65535へ変換する。device取得時計や未変換ADC bytesと呼ばない|
|`lib/ifx_smartar_hal/smartar_device.pyc`|`SmartarDevice.__init__`130、206、227–250|run_adc_calibration=Falseは可能だがreset/register書込みは残る。校正skipだけではread-onlyにならない|
|`lib/ifxradarsdk/fmcw/fmcw.pyc`|`DeviceFmcw.get_list`103、`__init__`184、`get_next_frame`353|C関数へ委譲。port指定はPython側列挙を迂回してcreate_by_portへ進むが、native初期化の安全性・互換性は別問題|

主なSHA256:

- device_smartar.pyc: `f6fe977117aecabaf382068a8370252ebc4e61aee7cd6466f99b98fab8e1bff1`
- frame_reader_smartar.pyc: `e2df222835c7da1dd175c378f89f58379466943e91a1eb661f136b5b1cda2d8f`
- fmcw.pyc: `bba73c2aa9eb558ddb9dff50f2ed937cffd9878cb0c243aff61b930527479454`
- `lib/ifxradarsdk/lib/sdk_fmcw.dll`: `c3c370e16af38d06ca41dad9441a8fc78333d05d9f4c8f78ed61fff00ba58548`

最後のDLLにはifx_fmcw_create_by_port、ifx_fmcw_get_next_raw_frame等のexportがある。lib_smartar.dllにStrataPort関連symbolも存在する。SDK base DLL内のversion文字列は正確には`3.6.4+4b4a6245`で、実機から返されたversionではない。C APIを追加する場合は公式header/ABIと機種・FW対応を確認し、export名だけから構造体や副作用を推測して実機へ接続しない。

## 保存済み識別値と現FWの既知UART経路

保存済みGET_SENSOR_CONFIGの`0x0e08 = 0x00098185`を同梱DeviceSmartarの定義（元source行65–71、89、121）と照合すると、RF bits0..7は0x85 → **BGT60CUTR13B**、STEP bits16..17は1 → **B**。以前の「現物step unknown」はこの既存値との照合不足によるもので訂正した。新規照会はしていない。

保存済みhost情報はKitProg3 UART COM10、VID04B4/PIDF155、UART interface MI02。現FWはindoor_people_localization 0.4.5.dev0+g2b14fe4.d20260212、sensor driver 0.5.12。これはStrata boardの識別結果ではない。Strata UUIDは未取得で、USB probe番号や承認UIのUUIDから推測しない。現在のCOM占有も確認していない。

保全済み現FW main imageの静的解析では、既知UART dispatcherがIDから1を引き0..8のtableへ分岐する。IDs1/4/5/8/9に処理があり、2/3/6/7と範囲外は未処理応答へ進む。これは既知dispatcherの証拠で、FW全体の別protocol/出力の不存在証明ではない。

- GET8はrequestのaddress/長さを読む形ではなく、818件の共有bufferを対象とする。保存済みdumpは0x0004..0x33fcでFIFO address 0x4000を含まない。ただしSET9とbufferを共有するため、固定countから固定addressだけと断定しない。
- SET9は最大818件のaddress/value listとmetadataを解析し、実register書込み・再初期化へ進む。任意listを受けることだけで安全なFIFO readやstream選択が可能とはいえない。
- GET8 workerにも停止相当制御→register read loop→元の有効状態へ戻す呼出しがある。GETという名前だけで稼働への影響なしと扱わない。今回このGETも実行していない。
- このreadはread command 2×16bit、data 2×16bitの通常32bit register read。公開driverの可変長FIFO burstと同一視できない。FIFO enable設定だけでPCへADCが送られることも確認していない。
- SWITCH_SOURCEはMCUへ渡す入力源の切替、PROCESS_FRAMEはPCからMCUへ渡すframeの処理で、確認した経路ではADC出力のselector/getterではない。

公開referenceと現dev FWの全体同一性は未証明。公開sourceの対応関数と、保全済み現binaryの解析は別々の証拠とする。

## 次の最小照会と、今回実行しなかった理由

既存logと公式定義だけでは、現FWがStrata board/data interfaceを提供するか判定できない。次表は照会候補の仕様を整理したもので、実行済みの手順ではない。**安全と確認できた、未取得情報を返す実機照会は現時点ではないため、今回追加の照会はしていない。** 不明なpacketを試す、constructorをpatchする、同じ探索失敗を反復する方法は採らない。

|経路・最小候補|target／要求と取得したい情報|副作用・要求bytesの確認状況|成立／不一致の判定範囲|
|---|---|---|---|
|DeviceSmartarの前段: `strata.BoardManager('serial').enumerate()`、必要なら列挙されたboardの作成とidentity取得|KitProg3 UARTに対応するboard。`getComponent('IRadarSmartar',0)`、`getIRegisters()`からID_HW 0x0e08、`getUuid()`、必要なIData/IBridgeDataの成立を確認する|Pythonのsensor constructorは使わない案。ただしnative列挙・board作成が送るserial要求bytes、初期化/reset/設定への影響は未確定。`withSerialPort('COM10')`もnative BoardSerial作成へ進むため、安全な単なるport確認と扱わない|protocol応答、UUID、B-step識別、各interfaceの成立を別々に記録する。0件・timeoutだけで非対応としない。identity成功だけでもADC streaming成功ではない|
|DeviceFmcwの前段: `DeviceFmcw.get_list()` → `ifx_fmcw_get_list`|このC SDK自身が認識する実device一覧・識別情報。DeviceSmartarの探索とは別判定|native discoveryの送信先・要求bytes・副作用の完全な契約は未確認。`create_by_port`はopen/init経路なのでread-only照会の代用にしない。`sensor_type`指定dummyは実機の確認にならない|SDK側device識別とB-step／現FWの対応を確認する必要がある。Python RadarSensor enum名や別APIの探索結果だけで可否を決めない|
|現FW UART: 既知GET1／GET8|GET1は既取得のFW版で、Strata/raw機能を識別しない。GET8はregister dumpで、ADC frameやboard protocolの照会ではない|既知dispatcher IDは1／8。wire framingは既存受信実装にあるが、GET8は停止・復帰相当を伴う。未知raw commandの要求bytesは定義できていない|既取得版の再照会では不足情報が増えないため実行不要。GET8やSET9をFIFO出力確認へ流用しない|

まず必要なのは、**現dev buildに対する公式のStrata serial discovery/identity手順（request bytes、対応protocol版、reset/設定/startをしないこと）か、既存raw出力protocolの仕様**である。これが確認できれば、使用中portを奪わず、一度だけ対応targetへ最小identity照会し、要求/応答原本とエラー層をprivateへ保存する。成功時もboard identity・interface適合までの結論に留め、取得開始は別の段階にする。仕様が得られない状態ではread-onlyと推定して実行しない。

## 優先する実装案

まず公式Strata/CSK protocol互換情報と、native列挙・board作成・identity取得の副作用を確認する。現dev buildの通信仕様、対応する公式read-only識別手順があれば優先する。B-step識別は既存値で足りるが、Strata UUID/protocol/interfaceの成立は未確認。constructor/openをpatchして副作用を隠す実機試験はしない。

互換経路を確認できたら、専用subprocessの公式SDK adapterを既存raw serviceへ接続する。discovery/identityと設定・校正・start/stopを分け、検出APIへ暗黙にfallbackしない。可能ならtakeFrameの変換前bytesを先に保存し、API/DLL版・board/FW/protocol・要求/実設定・shape/coding・source layout・hash・連番/欠損を残す。vendor reshapeとcanonical `[chirp,RX,sample]`の対応を確認し、元bytesを保持して明示変換する。

APIからdevice/sample timestampを得られなければunknownを維持する。PC配信時刻と設定由来のframe内Tcを別の時計basisで記録し、device取得時刻と称さない。frame間をcoherentに連結しない。この時計basis等は実SDK adapterを作る段階で追加する。現FWの既存raw送出が確認できればその受信実装を優先し、ないと確認された場合にMCU側送信機能の追加を選ぶ。FW書換えは保留し、最終FW状態を含む具体範囲の確定前には進めない。

## 公開一次情報と確認の限界

- [公式kit guide UG113247 Revision 1.10](https://www.infineon.com/assets/row/public/documents/30/44/infineon-ug113247-kit-csk-bgt60cutr13-xensiv-connected-sensor-kit-usermanual-en.pdf): §1.2、§3.2/3.3。kit構成、FW依存の通信、検出/追跡出力を説明。現dev buildの全protocol仕様ではない。
- [公式driver pinned source](https://github.com/Infineon/sensor-xensiv-bgt60cutrxx/blob/04c4f5e8419d72504db3da316f285aa12267ae43/xensiv_bgt60cutrxx.c#L290): get_regは通常32bit read、同file637以降のget_fifoは可変長burst。MCUからsensorへのAPI。
- [公式CSK reference pinned source](https://github.com/Infineon/mtb-example-psoc6-cmos-radar-people-tracking/blob/f6e9c82b28d0022790b0905201e1d6720615063d/src/common/terminal.c#L649): GET/SET handler。現dev FWとの全体同一性は未証明。
- [メーカーmoderatorのFIFO回答](https://community.infineon.com/t5/Radar-sensors/Raw-data-from-BGT60CUTR13AIP/td-p/1251406): FIFO rawとMDの併用可能性等を説明。現FWがPCへrawを送ることの証明ではない。

元code objectをfake backendだけで動かす7caseと、保全済みThumb関数＋SPI完全mockの2caseを確認した。native DLL、COM、debug、設定、測定、カメラは使っていない。mock成功は実機SDK互換やADC取得の成功ではない。実機rawは依然0件。
