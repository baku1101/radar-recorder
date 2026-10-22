# 実機ADCからのリアルタイムmicro-Doppler

0.5.0では、KITCSKBGT60CUTR13TOBO1 / BGT60CUTR13BのADC FIFOを独自FW `radc-0.2.0` からUSB-UARTで受け、PCでrange FFTとSTFTを計算して表示・保存します。検出点の速度を並べた表示とは別の処理です。メーカー提供の完成済みPC収録機能とは称しません。

## この個人PCで使う

1. `start.cmd` を実行し、表示された `http://127.0.0.1:8765` をChrome/Edgeで開きます。
2. 上部「生波形からのmicro-Doppler」で「CSK 生ADC（専用raw FW）」を選び、USBポートに `COM10` を指定します。
3. 「接続して実raw表示・保存を開始」を押します。FW/profile/silicon IDを確認してから開始し、設定読戻しと最初のADCを待ちます。「実機CSK FIFO由来のADC」とframe数が表示されます。
4. 縦軸のHz/m/s、距離ゲート、静止成分除去、色の下限を選べます。FFT/STFT設定は取得前に指定します。表示一時停止は取得を継続します。
5. 「raw取得/処理を停止」でSTOP・保存・ポート解放を待ちます。同じ開始ボタンで新しいセッションを作り再開できます。停止後のraw記録を選ぶと、再生・seek・読戻し検証・書出しができます。

起動だけでは接続しません。カメラは不要です。現在のraw FWは従来の検出・追跡UART APIを置換しているため、別欄の検出点表示や従来のレーダー＋カメラ記録には使えません。以前の検出機能に戻す場合は、停止後に保全した元FWを復旧する作業が必要です。

## FWとPC側の準備

このローカル環境には導入済みです。GitHubのソースを取得しただけではFW・vendor library・profile・Pythonは付属しません。新しいPC/基板では[FWビルド](../firmware/csk-raw/README.md)と[導入・復旧記録](MICRO_DOPPLER_PILOT.md)を確認してください。アプリは自動でflashを書き換えません。

PC側はPython 3.11とメーカーVisualization Tool 1.1.0同梱のserial libraryを利用し、独自readerを別プロセスで起動します。`RADAR_CSK_PYTHON` / `RADAR_CSK_VENDOR_LIB` は従来bridgeと共通です。取得設定は `.runtime/csk-profiles/raw-deployment.json`、別の場所は `RADAR_CSK_RAW_SETTINGS` で指定できます。`scripts/make-csk-raw-profile.py` は機器を開かずにprofile/header/deployment設定を生成します。

## データと時計

実装済みprofileは128 chirp × 1 RX × 64 sample、little endianの符号なし16bit格納です。設定されたADC averagingは16です。FIFOのheaderは無効、MDのFFT/CFAR等のFIFO選択も無効で、イベントやFFT結果をADCと読み替えていません。ADC分解能は[公式datasheet §9.2、p.30](https://www.infineon.com/assets/row/public/documents/30/49/infineon-bgt60cutr13aip-datasheet-en.pdf)では12bit＋4 fractional bitsです。格納語とネイティブ変換精度を区別します。

PC decodeは `readUInt16LE`、sample_offset=0、sample_scale=1、数値基準65535です。各chirpのfast-time平均を除去してから窓・FFTをかけるのでDCオフセットを動作成分と扱いません。dBの基準はuint16格納範囲で、アナログfull-scale・受信電力の校正値ではありません。

要求433レジスタと実読戻しを保存します。実機では413値が一致、ADC校正設定領域20値は読戻し0との差があり、意味・校正精度はunknownとして保存・表示します。この20項目以外が要求と異なる場合は停止します。実読戻しを公式parameter APIでオフライン解析し、shape、Fs、Tc、chirp slope、frame周期が要求値と一致することを確認しました。校正領域差からアナログ性能の成立までは主張しません。

|量|値・扱い|
|---|---|
|Fs / 出力chirp間隔Tc|5 MHz / 501.225 µs|
|frame周期 / frame内のsample時間幅|99.9614375 ms / 64.1568 ms|
|frame間の非取得区間|約35.8046 ms。連続chirpとしてつながない|
|128点STFTのbin間隔|15.5868 Hz、約0.0384449 m/s。2成分分離性能の実証とは別|
|速度Nyquist|約±2.46047 m/s、接近/遠ざかりの物理符号は未校正|
|UART|2 Mbaud 8N1、約164.2 kB/s。短い実受信を確認、長時間余裕は未評価|

frame位置はFIFO読出し後のMCU callback tick（ms）、frame内は設定Tcです。**真の取得開始時計はunknown**で、callbackの遅延・位相連続性を補正しません。各STFT窓は一つのframe内だけで計算し、gapの補間・frame間位相接続をしません。PC受信→処理時間と受信→今回描画の壁時計差を示しますが、物理取得→描画遅延とは呼びません。

## 保存と確認範囲

既定保存先は `data/sessions/raw-adc/<UUID>/`。元UART bytes、元packet、ADC payload、FW/profile識別、要求/実読戻し、clock basis、連番、CRC、PC受信時計、処理設定、全スペクトルと軸、hashを保持します。`source_sequence_discontinuities` とsample時間の空白 `time_discontinuities` を分け、機器欠損はunknownのままです。表示は500 ms周期で、描画・表示間引きは元bytes保存と別です。有限queueを超えた場合はエラー停止して未保存数を残します。

短い実機ADC取得、実GUIの開始・停止・再開、保存ログ再生、全53列/6784 power値/全軸の再計算・再読込一致を確認しました。実データ・画像・register dump・backupはprivateに保管しGitには含めません。人の動作の正解判定、歩行速度/方向の校正、frame間coherence、長時間連続運用、カメラ同期、学習・FPGAは今回の実証範囲外です。
