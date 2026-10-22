# 検証範囲と実施履歴

## 0.5.0 実機ADCとmicro-Doppler（2026-10-22）

ローカルの合成unit/HTTP/mockは **91/91**、合成micro-Doppler GUIは **14/14** 通過。新規CSK adapterは独立packet/clock保持、有限queue、readback不一致停止、校正領域差のunknown保持、停止・保存・再読込をmockで検証。uint16 little endian・DC除去・既知スペクトルの数値回帰も追加しました。FWのUART writerはARM emulationで一時0byte/partial writeと有限timeoutを検証しました。

同一kitに独自raw FWを導入し、実ADCを53frame、GUI10frame、再開9frame取得しました。元UARTとADCの対応、全53列/6784 power値/全軸の再計算・新規service再読込の完全一致を確認。CRC0、STOP応答、COM解放を確認し、実GUIで更新・停止・新ID再開・保存再生・読戻しを確認しました。GUI試験の旧セッション待機条件を修正し、早期STOPの0frame試行は成功数に含めません。必要な収録時間、FW/hash、復旧未試験の範囲は[導入記録](MICRO_DOPPLER_PILOT.md)、coding/clock/校正20読戻し差は[実rawガイド](DIRECT_RAW.md)に記載しています。

元ADC・画像・register dump・backupはGit対象外です。これは短い取得・ソフト処理の検証で、人の動作の正解、物理方向/速度校正、frame間coherence、取得→表示の物理遅延、長時間安定性、学習・FPGAの実証ではありません。

以下は従来バージョンの検証履歴です。


## 0.3.0の検出点ドップラー表示（2026年10月21日）

Windows・Node.js 24.19.0で、合成unit/HTTP **62/62**を通過。新しい12件は、属性列順と負/ゼロの元値、未知値を補わないこと、決定的な間引きと省略数、時刻範囲、5000件以降・末尾2 MiBの読取り、非同期yield、部分行/過大行/中止、保存ログ非変更、メモリ上限、表示停止中の受信、画面生存確認、切断、開始途中の停止、重複停止、解放完了までの排他、HTTP token/URL/ADC制約を検証する。

既存GUI **26/26**（レビュー16、合成カメラの収録10）も通過。新しい合成ドップラーGUI **18/18**で、速度/ビン切替・保存ログの再生/シーク・表示幅・保存やカメラなしの受信・表示一時停止/再開・画面再読込・停止/解放・元行との値一致・狭い画面・外部通信なしを確認した。合成GUIは計**44/44**。公開fixtureは変更せず、合成スクリーンショットはgit対象外のevidenceへ保存する。

本人の指示で現在接続中のKitProg3 USB-UARTを確認し、同じCSK adapterとGUIで**22イベント**を受信した。画面のPC相対時刻、speed_mps、doppler_bin、magnitude_dBFSを各元受信行と照合し、一致した。カメラ呼出し0回、録画セッション追加なし。表示一時停止中も受信が進み、停止後は件数が増えず、adapterの終了と接続解放を確認した。実イベントの時間幅は約1.63秒で、長時間性能の証拠にはしない。

別の5秒保存試験で**63検出**を保存し、元受信記録・件数・順序・時刻範囲・実設定ハッシュのreadbackが一致した。FW情報と設定のGET応答はOK。実データとレジスタ値はprivateのdata/evidenceだけに残し、Gitには含めない。カメラ撮影・設定変更・FW書込み・学習は行っていない。試験終了後に接続を解放した。

これは受信・表示・保存インターフェースの確認である。人の動作識別、速度符号の物理方向、binからHzへの換算、micro-Doppler全スペクトル、機器欠損率、物理同期精度、長時間連続動作を評価したものではない。今回受信した13列は検出対象の一覧であり、全ビンの強度やADC/FFTではない。現行bridge・adapterはそれらを取得せず、別FW/APIで取得できるかも未確認。

以下は0.2で実施した履歴であり、今回の試験件数と区別する。

2026年10月14日にWindows・Node.js 24.19.0で確認しました。ソースと公開fixtureは合成データのみです。実収録の原文・動画・レジスタ設定・個人PCの診断ログはGitに含めていません。

## 合成テスト

- 保存ファイル・同期・ラベル・HTTPの26項目を通過。
- 直接収録の18項目を通過。元メッセージと時計、RFC 6455通信、分割動画、二重操作、再開、切断、無受信、画面生存確認の途絶、バッファ超過、元記録破損、保存途中の復旧、接続中の終了、設定保存失敗を検証。最終のunit/HTTP合計は44/44。
- 既存日本語GUIの16項目を通過。
- 隔離headless Chromiumで直接収録GUIの10項目を通過。実カメラの代わりにcanvas映像を使い、製品のMediaRecorder・HTTP分割保存・動画結合を実行。収録中の保存、二重停止、再生、別セッションでの再開、レーダー切断時の動画保持を確認。
- Windowsの`start.ps1`がlocalhostのアプリを起動できることを確認。

GUI試験は専用プロファイル・GPU無効・localhost限定で実施し、実カメラ、マイク、既存ブラウザー、他作業の停止を行っていません。合成fixtureの短い試験は長時間品質の証拠にはしません。

## 実USBの確認

本人がUSB接続済みセンサーの検証を許可した後、KitProg3 USB-UARTを確認し、インストール済みメーカー1.1 APIで検出イベントを受信しました。`GET_FIRMWARE_INFO`と`GET_SENSOR_CONFIG`も正常応答しました。

アプリ本体のCSK adapterを使った5秒の検証では62件の検出イベントを保存し、元受信記録・件数・順序・時計範囲・設定ハッシュの読み戻しが一致しました。観測したshapeは`[1,13]`と`[2,13]`で、信号処理後の対象一覧です。raw ADC取得には該当しません。

実機応答はBGT60CUTR13、FW `indoor_people_localization 0.4.5.dev0+g2b14fe4.d20260212`、sensor driver `0.5.12`でした。実レジスタ設定は取得しましたが、その内容はローカルのセッションにのみ保存しています。基板の正式型番は未取得です。

この検証は検出イベントのインターフェース確認です。測定設定・FWの書込み、撮影、制御された被験者動作、学習、センサー精度評価は行っていません。対象のsequence_numをpacket連番とは扱わず、機器側の欠損は`unknown`です。

## 未確認

- 実カメラと実USBを同時に収録した結果、実露光時刻、物理同期精度。
- 長時間収録での帯域・ストレージ負荷・時計のずれ・連続欠損。
- 別機種、別基板、別FW、メーカーAPIの別版。
- メーカー1.1のWebSocketサーバーとの実機連携。1.1同梱HTML例と1.5のWebSocketフレーム記録の記載を、その成立の証拠とはしない。
- raw ADC、FFT、FPGA、動画モデルの自動ラベル、行動認識性能。

収録開始後は、実カメラの許可と映像を本人が確認し、開始側と終了側の目印を残してください。物理同期精度の確認は、ソフトウェアの読戻し照合と分けて行います。

## 同期時計名の静的QA修正

liveの数値軸はPC受信時刻を使っていましたが、同期の`radar_clock`とtraining.jsonのwarningsは元PC解読時刻の固定名でした。liveの名義を`pc_receive_time_relative_to_first_timed_record`に修正し、取込み/demoは従来の`original_pc_decode_time_relative_to_first_timed_event`を維持しました。liveではmetadata headerにも受信時計があるため、原点は最初の時刻付き保存レコードです。

合成回帰6/6で、モード別の時計名・warnings、旧syncとsync_historyの補正、起動時復旧・HTTP・一式書出しの整合を確認しました。目印、offset、scale、drift、不確かさ、外挿、対応区間と保存連番は変わりません。旧名の補正でも確認日時を保持し、元受信記録・frames.jsonl・session-config.jsonのバイトが変わらないことを照合しました。全unit/HTTPは50/50を通過しました。

この修正は時計metadataの訂正で、時刻の再計算や再同期ではありません。実カメラ・実センサーの追加収録は行っておらず、物理同期精度の確認状況は変わりません。


## 0.4.0 raw ADC/IQ処理の追加検証

- unit/HTTP: 77/77（既存62＋raw処理/保存/初回import12＋独自packet3）。全入力は合成。
- 既存GUI44/44、raw GUI14/14。isolated headless、カメラ権限要求0。合成ADC→FFT/STFT、Hz/m/s、pause中の保存継続、source bytes一致、保存再生、WebSocket取得/停止と排他、reload、狭幅を確認。
- 独自C encoderはGCC 14.2.1でCortex-M4向けにコンパイルし、ARM emulationで独立PythonのCRC32/byte列に一致。センサーは使わない。
- CSK向け独自mainは公式SDK/BSPをprivateに参照し、全238 translation unitsのコンパイル・リンク・ELF/HEX生成。128chirp候補の独立HEX監査でmain flash内41444bytes、record checksum、CM0+/CM4 vectorとReset_Handlerの整合を確認。boot/書込み未実施。
- 実測はbackup調査だけ。main/work/SFlash各2回readが一致、reset run後に元FW同一版と検出6件/disconnect。全register一致/復元書込みは未確認。QSPI/eFuse/RAMはbackup範囲外。
- 実機raw ADC取得0件。実測STFT、人の動作識別、長時間・物理同期は未検証。合成でのFFT/STFT成功と区別。

privateの元bytes・device backup・メーカーsource/objects・スクリーンショットは公開repoへ含めない。GUI画面例は合成明示のものだけをprivate evidenceへ保存。

## rawの空白・連番・CRC・保存再生を分離した合成QA

追加後のunit/HTTPは83/83（既存62、raw15、packet6）、raw GUIは14/14。実機・COM・FW・測定mode・カメラには触れていない。

- 正常連番でsample時間だけに空白を置くと、入力連番の不連続は0、sample時間空白は1。反対にsample時刻を連続させて入力連番だけを飛ばすと、それぞれ1と0。機器欠損は両方unknownを維持する。`time_discontinuities`は正常なframe間休止も数える既存fieldで、欠落数へ読み替えない。UIの名称を「宣言sample時間の空白（正常なframe間休止も含む）」とした。計算式・カウンタ数値は変更していない。
- CRCだけを破損させたpacketを、正常連番のまま同じsequenceで再送するcaseでは、CRC error 1、出力packet 2、連番飛び0。連番飛びだけのcaseではCRC error 0・skipped bytes 0。noise・不正サイズ・末尾未完結も別に検査する。CRCは受信bytesの整合検査であり、sampleの物理的正しさや機器内の欠損を証明しない。
- 候補と同じ128chirp×1RX×64sample、Tc 501.225µs、frame周期99.9614375msの**合成波形**を使う。3frameで128点窓は3列、64点窓/hop16は15列となり、全窓のstart/endが各frameのsample区間内に収まる。35.8046375msの正常空白をまたぐ窓は0、入力連番の不連続0、sample時間空白2。profileの実適用・連続chirpの実測ではない。
- bytes・frame開始0/0.256秒・処理設定を固定し、PC到着だけを変える。均一到着の壁時計1000/1256ms・単調時計1000000/257000000nsと、壁時計9000/5000ms（逆行）・単調時計4000000000/98000000000nsを比較した。合成sample時計、入力元が宣言したdevice sample時計、FIFO callback由来時計の3契約すべてで、全スペクトル列と全軸が厳密一致し、到着値は別metadataに保持される。device契約の試験bytesも合成で、実機時計を確認した結果ではない。
- frame開始やtime basisがunknown、またはPC到着時計をsample時計として指定した入力は拒否する。未取得のdevice capture time・物理frame起点の不確かさはunknown、`real_hardware_raw_verified`はfalseを維持する。FIFO callbackから物理取得時刻の正確さを主張しない。
- 保存前の計算結果と保存JSONL、新しく開いたserviceでの全履歴再生を比較し、全10列の時間・窓境界・連番、全1280個の`power_db`、128点ずつのHz/m/s軸とその他の軸metadataが厳密一致する。末尾抜粋や一部binの比較では代用しない。

これらはソフトの独立した条件と保存再生を検証するもので、実機raw取得0件・候補FW未書込み・復元書込み未試験という状態は変わらない。

最初のWindows CIでは、既存の保存失敗後122行再開テストだけが4秒の待ち上限で失敗し、追加raw/packet 21項目は通過した。この保存復旧テストはproductionのpumpを明示的に駆動し、保存失敗・再開・全122行・読戻しを検査する形に変更した。製品のタイマーや保存処理は変えていない。
