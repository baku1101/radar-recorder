# レーダー収録・レビュー 0.7.0-rc.2

Windows登録済みproxyで407になる場合は `setup.cmd -UseSystemProxy -ProxyUseDefaultCredentials` を使えます。パスワード保存やOS設定変更は行いません。[proxy設定](docs/WINDOWS_SETUP.md#proxy)を参照してください。

**取得条件切替の候補版です。新FW radc-0.3.0は未書込み・実機未試験です。** [10プリセット・操作と制約](docs/ACQUISITION_PRESETS.md) / [実機適用前のレビュー](docs/ACQUISITION_FW_REVIEW.md)。[実機確認済みstable v0.6.0](https://github.com/baku1101/radar-recorder/releases/tag/v0.6.0)はそのまま利用できます。旧radc-0.2.0での標準取得も維持しています。

個人PCでレーダーと動画を保存・確認するローカルアプリです。0.5.0ではKITCSKBGT60CUTR13TOBO1の実ADC FIFOを独自raw FWからUSB-UARTで読み、range FFT/STFTによるmicro-Dopplerをリアルタイム表示・保存・再生できます。従来の検出点表示・動画同期・日本語ラベル確認も保持しています。学習・FPGA接続は未実装です。

## Windows 10/11の別PCへ持っていく

Windows x64配布ZIPを展開し、`setup.cmd` → `start.cmd`（診断は任意の `doctor.cmd`） の順で実行します。専用Node/Python/pyserialをフォルダ内へ配置するため、管理者権限や既存runtime、メーカーVisualization Toolは不要です。offline ZIPも用意できます。**すでにraw FW `radc-0.2.0`を導入した同じキット**が対象で、セットアップからFWは書き込みません。[手順・保存先・更新・トラブル対処](docs/WINDOWS_SETUP.md)を参照してください。

## 起動と実機micro-Doppler

Node.js 22以上が必要です。Windowsで `start.cmd` を実行し、`http://127.0.0.1:8765` をChrome/Edgeで開きます。通常のNode環境では `npm start` も使えます。終了はCtrl+Cです。

1. 「生波形からのmicro-Doppler」で「CSK 生ADC（専用raw FW）」を選びます。
2. USBポートを `COM10` にし、「接続して実raw表示・保存を開始」を押します。
3. 「実機CSK FIFO由来のADC」とframe数を確認し、Hz/m/s軸や表示範囲を選びます。
4. 「raw取得/処理を停止」で保存とポート解放を待ちます。同じ開始ボタンで新規セッションとして再開できます。停止後は記録を選んで再生・seek・読戻し検証・書出しができます。

この個人PCには `radc-0.2.0` とprivate runtime設定を準備済みです。raw FWは従来の検出/追跡FWを置換しているので、下の検出点表示・レーダー＋カメラ収録には元FWの復旧が必要です。起動だけでは機器接続も書換えもしません。カメラは使いません。

GitHubにはメーカーコード・FW binary・private profile・実収録を含めません。新しいPC/基板では別途準備が必要です。[実rawの操作・時計・制限](docs/DIRECT_RAW.md)、[FWビルド](firmware/csk-raw/README.md)、[導入・元FW復旧](docs/MICRO_DOPPLER_PILOT.md)を確認してください。

`start.ps1 -Port 8766`、`-DataDirectory <絶対パス>`、通常Nodeの `RADAR_PORT` / `RADAR_DATA_DIR` で変更できます。

## 更新後に開始ボタンが反応しない場合

起動したままソースを更新すると、古いNodeサーバーが新しいHTMLだけを返し、新しい画面プログラムやAPIを提供できない場合があります。0.6.0はその組合せを検出し、開始ボタンの直下に再起動案内を表示します。既存収録を終了してから元の起動ウィンドウをCtrl+Cで閉じ、start.cmdを起動し直し、ブラウザをCtrl+F5で再読み込みしてください。使用中ポートに二つ目のサーバーは起動しません。

クリック直後は「開始要求を送信中」、続いて接続・FW確認・設定読戻し・最初のADC待ち・受信中がボタン直下に出ます。設定やCOM接続のエラーも同じ場所に表示します。受信中はframe数とグラフが更新されます。

## 合成と保存データ

「合成ADCで処理を確認」はセンサーを使いません。実機と合成の由来を画面に残します。既存のraw JSONLやローカルraw WebSocketも入力でき、保存済みADCから全スペクトルを再生できます。検出点の時刻―速度/ビン表示は別欄に保持し、ADCからのスペクトルとは区別します。

[FFT/STFTの仕様と入力契約](docs/MICRO_DOPPLER.md)も参照してください。

## 標準検出FW用のUSB / UARTの準備

以下は従来の検出FWを使う場合です。現在導入済みの専用raw FWでは上の生ADC表示を使用してください。

WindowsのInfineon XENSIV CMOS Radar Visualization Tool **1.1.0**を、メーカーの利用条件に従ってインストールしてください。独自bridgeが、その配布APIの `SerialTransport`、`BinaryProtocol`、`DeviceClient` を別プロセスから呼びます。メーカーのコード・ドライバ・設定プリセットはこのリポジトリに含めていません。

配布APIにはCPython 3.11が必要です。既存の3.11を使う場合:

```powershell
$env:RADAR_CSK_PYTHON = 'Python 3.11のpython.exeへの絶対パス'
$env:RADAR_CSK_VENDOR_LIB = 'Visualization Tool 1.1.0のlibフォルダへの絶対パス'
.\start.ps1
```

標準のメーカーインストール先はユーザーフォルダ内の `Infineon/Tools/XENSIV-CMOS-Radar-Visualization-Tool/1.1.0/lib` です。そこにある場合は `RADAR_CSK_VENDOR_LIB` を省略できます。

Python 3.11がない場合は `setup-csk.ps1` で [python.orgのWindows埋込み版](https://www.python.org/downloads/release/python-3119/)を `.runtime/` に展開できます。PATHや既存Pythonを変更しません。3.11.9は3.11系列の最後の公式Windowsバイナリ版であり、その後のセキュリティ修正版とは異なります。保守された既存の3.11ビルドがあれば、そちらを指定してください。

```powershell
.\setup-csk.ps1
.\start.ps1
```

正しいCOM番号を入力します。他アプリが同じCOMポートに接続中なら接続エラーを表示します。他プロセスを停止したり、COMを強制解放したりしません。

CSK経路は現行FWが既に出力している検出イベントを受信します。開始時に `GET_FIRMWARE_INFO` と `GET_SENSOR_CONFIG` を照会し、実機応答を保存します。設定書込み・取得モード変更・FW書込みは行いません。イベントを出していないFWはタイムアウトで止まります。

今回確認した条件はBGT60CUTR13、KitProg3 UART、2,000,000 baud、FW `indoor_people_localization 0.4.5.dev0+g2b14fe4.d20260212`、sensor driver `0.6.02` です。他機種・基板・FW・配布API版は未確認です。基板の正式型番は取得できず `unknown` として残します。

## 操作

### リアルタイムのドップラー表示

カメラを使わず、保存もせずに表示できます。接続方法とCOM番号を確認して「表示を開始（保存・カメラなし）」を押してください。今のCSK経路では、USB接続した現行FWが出力する検出イベントを受信します。「表示を止めて接続を解放」で終了します。表示と直接収録は同時に同じセンサーを使えません。収録したい場合は表示を止めてから「レーダー＋カメラを開始」を押します。

横軸は最初の受信からのPC相対時刻、縦軸は元データの`speed_mps`（m/s）または`doppler_bin`（bin）です。点にカーソルを合わせると元の値・受信連番・行番号を確認できます。色分けには検出点の`magnitude_dBFS`を使い、表示範囲の最小/最大値を凡例に示します。速度の符号と接近/離反の対応、binからHzへの換算は未確認なので変換しません。

これは検出点の時間変化です。未検出の速度成分まで含むmicro-Doppler全スペクトルは取得していません。このアプリのbridge・adapterは検出イベントだけに対応し、raw ADC/IQ・複素FFT・全ビン強度を取得しません。別FW/APIで全スペクトルを取得できるかも未確認です。将来の全スペクトル表示には、全ビンの時系列強度またはFFT/ADC/IQと、サンプル周期・chirp/frame構造・周波数/速度軸の根拠が必要です。

表示幅は10/30/60/120秒です。「表示を一時停止」は画面だけを止め、ライブ受信は続けます。画面は最大2回/秒で更新し、モニターは直近12,000点をメモリに保持、1応答最大6,000点に間引きます。保持上限による省略と表示間引きの数を表示します。これらは表示用の制限であり、機器欠損の測定ではありません。未取得値や検出のない時間は補間しません。画面との通信が15秒途絶えた場合や1時間に達した場合は接続を解放します。

「デモで試す」または既存JSONLを読み込むと、同じグラフで保存ログを再生・シークできます。保存ログの横軸は各モードの既存PC時刻基準に従います。収録中のプレビューは末尾2 MiBまで読み、読み込み範囲の制限を表示します。古い時点へのシークはファイルを非同期で読みます。表示の省略や一時停止は、元の保存ログ・同期・ラベルを変更しません。

### レーダーとカメラの直接収録

1. 「直接収録する」に収録名と接続方式を入力します。被験者ID・シナリオ・分割グループは「新しい記録を作る」の入力を引き継ぎます。
2. 「レーダー＋カメラを開始」を押し、ブラウザーでカメラを許可します。音声は要求せず、標準は640×480・最大15 fpsです。カメラの実値は取得できた範囲で保存します。
3. 開始側と終了側に、動画とレーダーの両方で確認できる同期目印を残します。
4. 「収録を停止して保存」を押します。収録中に動画分割を保存し、停止後に最後の分割を含めて連番・件数・SHA-256を確認し結合します。
5. 2つの目印からoffset・drift・不確かさを保存します。日本語の行動名と開始・終了秒を区間に追加し、本人確認・修正・除外を行います。「その他」「不明」も使えます。
6. 「読み戻しを検証」してtar.gz、学習用JSON、区間CSVを書き出します。本人確認済みで同期できた区間だけを学習用に含めます。

停止・中断後の「新しく再開」は別セッションを作り、`resumed_from` に元IDを残します。停止中の空白を連続データとして埋めません。保存ファイル取込みの再開は従来どおり次の行から続けます。

切断・無受信・カメラ失敗・保存失敗・受信バッファ超過は中断です。収録画面との通信が15秒途切れた場合もレーダーを止めます。保存済みの受信記録と動画分割を保持します。未保存の動画分割がブラウザーに残った場合は画面から退避できます。ブラウザー終了やディスク故障で未保存データまで必ず復旧できる保証はありません。

収録上限は1時間、レーダー256 MiB、動画1 GiB、1動画分割8 MiBです。長時間の帯域・連続欠損・実カメラ安定性は未検証です。

## WebSocket・取込み・デモ

WebSocket経路は同じPCの `ws://127.0.0.1:<port>` などからJSONテキストの `detections.attributes` / `detections.data` を受信します。外部ホスト、URL内の認証情報、バイナリADC/FFTには対応しません。センサー開始コマンドは送りません。

メーカー1.1.0にはWebSocketからイベントを表示するHTML例が同梱されています。[1.5の更新履歴](https://softwaretools.infineon.com/tools/com.ifx.tb.tool.xensivcmosradarvisualizationtool)のWebSocketフレーム記録は別機能です。今回のWebSocket試験は合成サーバーとの連携です。実機のメーカー1.1サーバー連携は未確認で、USB検証はCSK UART経路で行いました。

「デモで試す」は合成JSONLと合成動画を使い、実機・カメラを使いません。保存済みJSONLとMP4/WebM/MOV/M4Vも取り込めます。各256 MiB以内で、元バイトを保持します。公開の診断fixtureもすべて合成です。

## 時計・ラベル・保存

ライブ元メッセージを `raw.events.jsonl` の `message_utf8` に保存し、PC受信Unix時刻とプロセス単調時計を追加します。CSKのシリアル行とメーカーAPIの解読結果も区別して保持します。元 `ts` は上書きしません。`frames.jsonl` に種別・shape・保存連番・元行・時計・エラー・欠損を保存します。

PC受信時刻は機器取得時刻ではありません。`receiver_sequence` はアプリ保存順で、対象の `sequence_num` はpacket連番と同一視しません。機器側欠損は未確認なら `unknown` です。カメラcallback時計も露光時刻ではありません。ソフト時計の一致は物理同期精度の実証ではなく、目印の確認を必要とします。

ラベルの出所と確認状態を別保存し、元候補と修正履歴を保持します。自動動画モデルは501の未実装エラーを返します。外部の候補JSONには対象動画のSHA-256が必要で、本人レビューしてから学習用に含めます。

保存先は `data/sessions/<UUID>/` です。受信記録をfsyncした後、フレームとmanifestを更新します。保存途中で止まった場合は完全な受信記録から復旧し、不完全な最終行やハッシュ不一致は拒否します。

Gitにはソース・説明・合成fixture・合成テストだけを含めます。個人動画、実収録、実レジスタ設定、診断ログ、メーカー配布コード、認証情報、`.runtime/` は公開しません。データを自動でGitへ追加・アップロードする機能はありません。

詳細は [保存契約](docs/FORMAT.md) と [検証結果](docs/VALIDATION.md) を参照してください。

## テスト

```sh
npm test
npm run test:ui
npm run test:capture-ui
npm run test:doppler-ui
```

GUI試験には `RADAR_HEADLESS_CHROME` でChromium headless shellを指定します。専用プロファイル・合成canvasを使い、実カメラ・GPU・既存ブラウザーを使用しません。

実機試験は通常テストとCIに含めません。本人が5秒の検出受信を許可した場合だけ、Windowsで `RADAR_USB_TEST_PORT` を対象COMに設定し、`node test/usb-smoke.mjs` を実行します。測定設定の書込みや撮影は行いません。
