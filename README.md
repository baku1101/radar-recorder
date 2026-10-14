# レーダーレビュー 0.2.0

個人PCでレーダーの検出イベントとカメラ動画を直接収録し、同期目印と日本語の区間ラベルを本人が確認するローカルアプリです。raw ADC、FFT、FPGA、動画モデルによる自動ラベル、学習処理は未実装です。

## 起動

Node.js 22以上が必要です。Windowsでは `start.cmd` を実行し、表示された `http://127.0.0.1:8765` をChromeまたはEdgeで開きます。通常のNode環境では `npm start` も使えます。終了はCtrl+Cです。

```powershell
cd radar-recorder
.\start.ps1
```

ポート変更は `start.ps1 -Port 8766`、保存先変更は `-DataDirectory <絶対パス>`。通常のNode起動では `RADAR_PORT` と `RADAR_DATA_DIR` を指定できます。起動するだけではカメラやレーダーに接続しません。

## USB / UARTの準備

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

今回確認した条件はBGT60CUTR13、KitProg3 UART、2,000,000 baud、FW `indoor_people_localization 0.4.5.dev0+g2b14fe4.d20260212`、sensor driver `0.5.12` です。他機種・基板・FW・配布API版は未確認です。基板の正式型番は取得できず `unknown` として残します。

## 操作

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
```

GUI試験には `RADAR_HEADLESS_CHROME` でChromium headless shellを指定します。専用プロファイル・合成canvasを使い、実カメラ・GPU・既存ブラウザーを使用しません。

実機試験は通常テストとCIに含めません。本人が5秒の検出受信を許可した場合だけ、Windowsで `RADAR_USB_TEST_PORT` を対象COMに設定し、`node test/usb-smoke.mjs` を実行します。測定設定の書込みや撮影は行いません。
