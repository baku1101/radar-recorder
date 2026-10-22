# 生波形からのmicro-Doppler

0.5.0はADC/IQの元bytesを保存し、range FFT→slow-time STFTでスペクトログラムを計算します。接続済みCSKには独自 `radc-0.2.0` を導入し、実FIFO ADCで表示・停止・再開・保存再生を確認しました。標準検出FWのイベントをrawと読み替える処理はありません。

操作、実機profile、sample coding、設定読戻し差、時計の限界は[実rawガイド](DIRECT_RAW.md)を参照してください。合成ADCの画面は実機未使用と表示します。入力のreal自己申告と、専用FW/ID/読戻し/CRCを照合した実機CSK ADCを区別します。

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

保存先は `data/sessions/raw-adc/<ID>/`。アップロード原本、source-config、要求/適用した解析設定、元envelope、各frameのbinとshape/timing/PC時計、SHA256、導出spectrumを保存します。元bytesをfsyncしてからworkerで計算し、未処理frameや中断を成功扱いにしません。raw記録は既存検出点・行動ラベル用datasetへ自動で混入させません。

## 取得経路と検証

運用経路は、公式CUTRxx driverのSPI/FIFOを使う独自MCU producer→KitProg3 UART→独自PC readerです。メーカーの公式PC SDKが不可能と証明したという意味ではありません。[既存PC APIの静的調査](PC_RAW_API_PATHS.md)は当時の標準FWについての記録です。メーカーVisualization Tool 1.5も通常の公開配布を確認しましたが、今回の実測経路とは別です。

[公式CUTRxx driver](https://github.com/Infineon/sensor-xensiv-bgt60cutrxx)、[公式CSK reference](https://github.com/Infineon/mtb-example-psoc6-cmos-radar-people-tracking)、[ADC datasheet](https://www.infineon.com/assets/row/public/documents/30/49/infineon-bgt60cutr13aip-datasheet-en.pdf)を元に、privateの依存を利用します。メーカーsource/profileはこのrepoへ転載しません。[独自FWビルド](../firmware/csk-raw/README.md)と[導入・復旧記録](MICRO_DOPPLER_PILOT.md)を参照してください。

合成実数ADC/複素IQは既知周波数・振幅・符号・全軸・全power値・gap/連番/CRC・到着jitter・保存再生・失敗/中断を検証します。実機では短いADC取得、全53列/6784値/全軸の元bytes再計算・再読込一致、GUIライブ・停止・再開・再生を確認しました。原本・画像はprivateのみです。人の動作分類、物理方向/速度校正、長時間、frame間位相連続性は未実証です。
