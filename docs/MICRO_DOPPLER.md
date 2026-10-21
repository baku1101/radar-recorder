# 生波形からのmicro-Doppler

0.4.0は、元のADC/IQサンプルを保存し、range FFTとslow-time STFTからスペクトルを計算します。既存の検出点グラフとは入力も計算も別です。

**接続中CSKの現FWで実測rawはまだ取得できていません。** `indoor_people_localization 0.4.5.dev0+g2b14fe4.d20260212` のUART出力はFW処理後の検出点です。検出点から全スペクトルを復元する処理はありません。画面の「合成ADCで処理を確認」は実機を使用しません。

## 使い方

`start.cmd` または `npm start` で起動し、`http://127.0.0.1:8765` を開きます。

1. 「生波形からのmicro-Doppler」で「合成ADCで処理を確認」を押すと、既知の搬送波・sample timingで生成したADC波形を保存してFFT/STFTを実行します。合成の表示を常に残します。
2. 縦軸をHzまたはm/sに切り替えられます。横軸は入力で宣言された時計上のSTFT窓中心です。接近/離反の符号は実機で校正していません。
3. 表示の一時停止は受信・元bytes保存を継続します。取得停止は受信終了と保存処理を待ちます。保存ログの再生・seek・読戻し検証・tar.gz書出しに対応します。
4. 実raw JSONLを読み込むか、必要なmetadataを持つローカルraw WebSocket producerに接続できます。現在のCSK FWを選んでもraw成功にはせず、未対応のエラーを表示します。

カメラは不要です。検出点収録と外部raw取得は同時にセンサーを開けません。表示poll・描画・FFT workerは取得から分離しています。ただしdiskやCPUが追いつかない場合まで無損失を保証しません。

## 計算と軸

形は `[chirp, RX, sample]`。実数ADCと複素IQを区別します。

- 各chirp/RXのfast-time平均を除き、Hann窓を掛けてrange FFTを実行。正のrange FFT binから指定距離のbinを選びます。DCとNyquistは除外します。複素IQも正のbeat側が距離に対応する入力契約です。負のbeat側に距離が載るIQは未対応です。
- 選んだrange/RXごとの複素slow-time系列にHann STFTを掛け、各binの電力を非コヒーレント平均します。静止成分の除去は明示的なオプションです。
- 周波数binは `fd = (k − L/2)/(L Tc)`、速度は `v = c fd/(2 fc)`。`Tc`は出力chirp間隔、`fc`は入力の中心周波数です。正符号は選択したrange binの正の位相回転を意味します。
- 周波数bin間隔は `1/(L Tc)`、速度bin間隔は `c/(2 fc L Tc)`。これは2成分を分離できる実分解能の実証ではありません。Hann窓の主ローブ幅やSNRにも依存します。
- range FFT bin間隔は `c Fs/(2 S Ns)`。ここで`S`はchirp slopeです。メーカーが有効帯域から算出するrange resolutionと、このFFTのbin間隔は同じ定義とは限りません。
- 色は指定されたADC full-scaleを基準に、Hann coherent gainで補正した平均電力の `10log10`。dBの基準は入力metadata次第で、受信電力の校正値でも、検出点の`magnitude_dBFS`でもありません。

frameごとにSTFTを完結させます。frame間gapや欠損を連続chirpとして接続せず、空白を補間しません。これにより長い観測窓は、実際に1 frameへ入る連続したchirp数に制限されます。異なるRX/rangeの電力平均には位相同期の主張を含めません。

## raw入力契約 v1

JSONL先頭は `{ "kind":"raw_adc_header", "schema_version":1, "config":{...} }`。必須config:

|項目|内容|
|---|---|
|data_kind / sample_format|`real_adc`: `int16_le`, `uint16_le`, `float32_le`。`complex_iq`: `complex64_le`（float32 I,Q交互）|
|layout / shape|`chirp_rx_sample`、samples_per_chirpは16〜1024の2の累乗、chirps_per_frameは16〜512、rx_countは1〜3、rx_orderを明示|
|sample_rate_hz / chirp_interval_s|実際のFs、出力chirp間隔。未知なら解析しない|
|carrier_hz / chirp_slope_hz_per_s|実際の中心周波数、正のslope。速度・距離の根拠|
|sample_scale / sample_offset / adc_full_scale|復号と色の基準。装置や数値型から勝手に推定しない|
|provenance|`synthetic` または `real`。realは入力側の宣言で、独立した実機確認とは別|
|time_basis / timing_source.reference|合成sample時計、装置sample時計、producer宣言sample時計、または`device_fifo_callback_clock_with_configured_chirp_spacing`。出典必須|

frameは `kind:raw_adc_frame`、単調な `sequence`、`frame_start_s`、`payload_base64`、任意の `payload_sha256` を含みます。元bytes数がshapeに一致しなければ拒否します。装置連番・装置取得時刻がなければunknownのままです。

FIFO callback時計は取得時計ではありません。frame配置の遅延・不確かさはunknownで、frame内の相対間隔だけが宣言されたTcに基づきます。PC受信時刻と混ぜません。UART bridgeはcallback由来のframe位置とpacket連番を別名で保存します。

`time_discontinuities`は、宣言された前frameのsample区間末尾と次frame開始との間に空白があった回数です。正常なframe間休止も含み、転送欠落数ではありません。`source_sequence_discontinuities`は入力連番の飛びを別に数えます。どちらからも機器欠損の有無・個数を断定せず、`device_loss`はunknownのままです。各STFT窓は一つのframe内だけから生成します。

PC到着時刻は元envelopeとframe metadataに保存し、STFT時刻やHz/m/s軸の計算には使いません。到着jitterやPC壁時計の逆行からsample時刻を補正しません。`frame_start_s`や必要なsample clock/timingがunknownなら、PC到着時刻で埋めず入力を拒否します。device capture timeと物理frame起点の不確かさは、未取得ならunknownを維持します。

最大1MiB/frame、256MiB/記録、4096 frame。WebSocketはloopbackだけで、queue上限8件、16MiB、受信停止・overflowを明示します。アプリが保存しなかった受信数とsourceの欠番を分け、機器欠損はunknownを維持します。

保存先は `data/raw-adc/<ID>/`。アップロード原本、source-config、要求/適用した解析設定、元envelope、各frameのbinとshape/timing/PC時計、SHA256、導出spectrumを保存します。元bytesをfsyncしてからworkerで計算し、未処理frameや中断を成功扱いにしません。raw記録は既存検出点・行動ラベル用datasetへ自動で混入させません。

## 現物と取得経路の確認結果

現物OPNは **KITCSKBGT60CUTR13TOBO1**。製品ページはBGT60CUTR13AIPとCSK/PSoC6の組合せを示します。従来のBGT60TR13Cとは別です。[公式kit](https://www.infineon.com/evaluation-board/KIT-CSK-BGT60CUTR13)

|経路|確認できたこと|未確認・必要な操作|
|---|---|---|
|現行CSK UART FW|同梱TerminalCommandにraw readなし。GET_ALGO_CONFIG/GET_USER_ALGO_CONFIGも現FWでERROR。検出点は受信実績あり|全ADC/full FFT出力なし。既存検出イベントをrawへ読み替えない|
|Strata/DeviceSmartar|同梱FrameReaderにはADC frame APIが存在。read-only discoveryでは`No connected devices found`|現在のKitProg3 UARTとは別経路。USB driverだけで解決する証拠なし|
|公式CSK reference|exact CYSBSYSKIT-DEV-01 target、off-chip ADC FIFO branchとJapan profileあり|UARTへADCを流す独自producerが必要。準備したC/bridgeは現FWに存在しないprotocol|
|同梱FW候補|CSK向けevaluation/PDT/localizationのHEXを確認|現dev buildと同一の復元imageは未確認。これらがraw UART producerだとも未確認|
|backup/restore|公式ProgrammerにRead/Verifyあり。許可されたSWD調査でmain/work/SFlashを各2回private読出し、hash一致、元FW起動/検出出力/disconnectを確認|復元書込みは未実証。QSPI/eFuse/RAMは対象外。校正/MD/SEQ_BUFFER等の全register一致も未確認|

同梱API根拠は Visualization Tool 1.1.0 の `lib/ifxapp/hardware_access/event_readers/protocols/protocol_interface.pyc`（TerminalCommand）、`frame_readers/frame_reader_smartar.pyc`、`event_readers/smartar_motion_detector_bstep/device_smartar.pyc`。これらのメーカーコードは配布しません。JSONL検出ログに付く「raw」という呼称とADCを区別します。

[公式CUTRxx driver](https://github.com/Infineon/sensor-xensiv-bgt60cutrxx)、[公式CSK reference](https://github.com/Infineon/mtb-example-psoc6-cmos-radar-people-tracking)、[ADC仕様](https://www.infineon.com/assets/row/public/documents/30/49/infineon-bgt60cutr13aip-datasheet-en.pdf)、[ProgrammerのRead/Verify](https://www.infineon.com/assets/row/public/documents/30/44/infineon-modustoolbox-programmer-gui-user-guide-usermanual-en.pdf)

## 独自FWの準備状態

`firmware/csk-raw/` と `scripts/build-csk-raw.py` は独立実装です。メーカーsource/profile/BSP/compilerは`.runtime/`へ別途用意します。[FW手順と制限](../firmware/csk-raw/README.md)を参照してください。書込みは実施していません。

初期Japan profileは17 chirp×3RX×64 sample、16回平均後のADC FIFO。オフラインの同梱HAL解析によるTcは501.225µs、frame周期50.1622625msです。16点窓は8.0196ms、124.694498Hz/bin、約0.30756m/s/bin、速度Nyquist約2.46047m/s。frame間に約41.6414msの空白があります。6528 bytes/frame＋32 byte headerで約130.8kB/s、2Mbaud 8N1の理論上限200kB/sの65.4%です。これらはprofile解析値で、連続伝送の実測ではありません。

より長い窓の候補として、同じ公式profileを同梱HALでオフライン変更した128 chirp×1RX×64 sample、約99.9614375ms/frameも用意しました。Tc・16回平均・帯域は維持します。128点窓は64.1568ms、約15.58681Hz/bin（約0.03844m/s/bin）、frame間gapは約35.80464ms。16384 bytes/frame＋headerで約164.2kB/s、理論上限の82.1%のため、実測の余裕は未確認です。1RXなので角度処理を提供しません。平均化による周波数応答・位相安定性・実際の欠損も実機試験が必要です。Nyquistを超える動作はaliasします。

PSoC part/BSPの適合と、レーダーのsilicon step/profileの適合を分けます。独自mainはB-stepの既知IDを設定前に読み、不一致・unknown時はprofileを書かず停止します。現物のstepはまだ実読出しできていません。ビルド成功は実機raw取得、boot、micro-Dopplerの動作確認を意味しません。

## 検証範囲

合成の実数ADCと複素IQで、独立DFTとのFFT照合、既知の正負周波数、速度換算、既知振幅、距離gate、静止除去、時間変化する位相を検証します。実数ADCは「実測」の意味ではありません。GUIも合成入力です。独自C encoderはCortex-M4向けにクロスコンパイルし、ARM emulationで独立Python CRC/byte列と照合します。

実測raw、実測STFT連続更新、人の動作の識別、物理同期、長時間取得は未確認です。ソフト側が合成で通過しても、この実機取得の未達成は残ります。

具体的な候補HEX/hashと、書込み・5秒raw試験・復帰・試験後の状態を本人が判断するための[手順案](MICRO_DOPPLER_PILOT.md)を用意しています。書込みは未承認・未実行です。
