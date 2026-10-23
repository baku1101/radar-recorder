# 取得条件の切替候補 0.7.0-rc.1

この版はソフトウェア・FWビルド・模擬通信を確認した候補版です。新FW `radc-0.3.0` の実機書込み・起動・新profileでのADC取得は行っていません。稼働中のアプリ、センサー、既存データには変更を加えていません。stable v0.6.0と、実機で動作確認済みの `radc-0.2.0` は維持します。

## 使い方と互換性

Windows 10/11 x64用の専用Node/Python/pyserialセットアップは従来どおりです。通常運用PCにメーカーSDKは不要です。別フォルダへ候補版をclone/展開し、`setup.cmd` を実行します。既存サーバーを止めずに起動確認する場合は、専用runtimeのNodeを用い、空いている別ポートと新しいデータフォルダを明示してください。利用中のフォルダへ上書きしたり、取得中に更新・再起動したりしません。

```powershell
git clone --branch runtime-acquisition-config https://github.com/baku1101/radar-recorder.git radar-recorder-candidate
cd radar-recorder-candidate
.\setup.cmd
# 通常の利用は start.cmd。別サーバーが8765を使用中なら二重起動を拒否します。
```

`radc-0.2.0` では従来の標準取得・保存・再生を使用できます。取得条件の切替は無効です。新FW導入後に使う候補の操作は次のとおりです。

1. このPCのCOM番号を選び、「センサーの取得条件」を開きます。
2. 「FW機能を確認」を押します。この操作はポートを一時的に開いて `RADC_INFO` だけを読み、閉じます。設定・測定・FW書込みは行いません。他アプリが使用中なら失敗し、奪いません。
3. `radc-0.3.0` と一致するcatalogが確認された場合だけ、プリセットを選べます。宣言値、観測時間、frame間空白、UART転送量が表示されます。
4. Nc/Nsが変わる場合、STFT窓・hop・距離範囲を収まる値に変更し、その変更値を画面に表示します。利用者は開始前に調整できます。空の距離gateや過大な窓は拒否します。
5. 開始時に停止中のFWへSETCONFIG、GETCONFIGを送り、実レジスタ読戻しを検査・保存してからSTARTを許可します。取得中・停止待ち・確認中は設定変更できません。停止して、新しいセッションで次の条件を選びます。

新FWで「FW機能を確認」を省いた場合は構成不明として開始を拒否します。未知FW、異なるcatalog、読戻し不一致、timeout、切断、metadata保存失敗を成功扱いしません。

## 対応する10プリセット

以下は公式B-step設定APIから生成・再読込みした**宣言値**です。RF実測値や新profileの実機取得結果ではありません。Tcとframe周期は設定に連動する値で、独立自由入力ではありません。shapeの順は [chirp, RX, sample] です。

| ID | shape | Fs MHz | 平均化 | gain dB | Tc µs | frame ms |
|---|---|---:|---:|---:|---:|---:|
| japan-default | 128×1×64 | 5 | 16 | 42 | 501.225 | 99.961438 |
| short-frame | 64×1×64 | 5 | 16 | 42 | 501.225 | 67.883038 |
| long-window | 256×1×32 | 5 | 16 | 42 | 400.625 | 138.364638 |
| more-samples | 32×1×128 | 5 | 16 | 42 | 707.825 | 58.455038 |
| fewer-samples | 128×1×32 | 5 | 16 | 42 | 400.625 | 87.084638 |
| lower-sample-rate | 128×1×64 | 2.5 | 16 | 42 | 707.825 | 126.406238 |
| three-rx | 16×3×64 | 5 | 16 | 42 | 501.225 | 43.824238 |
| shorter-tc | 64×1×64 | 5 | 8 | 42 | 360.625 | 58.884638 |
| lower-gain | 128×1×64 | 5 | 16 | 36 | 501.225 | 99.961438 |
| narrow-sweep | 128×1×64 | 5 | 16 | 42 | 501.225 | 99.961438 |

通常のsweepは約60.50998–60.98966 GHzです。long-window / fewer-samples / narrow-sweepは60.6 GHz開始・約300 MHz幅です。ADC観測開始/終了周波数はsweep全体とは別にmetadataへ保存しています。全profileの厳密な値・hashは [acquisition-presets.json](../profiles/acquisition-presets.json) にあります。任意数値、独立Tc/frame周期、TX power変更、frame間空白を連続chirpとして接続するSTFTは未対応です。

1frame最大8192個のuint16、FIFO最大4096word、2 Mbaud 8N1の理論200 kB/sに対し170 kB/s以下を候補生成時・host開始前に検査します。最大候補は約164.54 kB/sです。これは通信の実測保証ではありません。全RXのFIFO並びはchirp→sample→RXとして解釈し、DSP用の作業配列のみchirp→RX→sampleへ並べ替えます。受信bytesと保存ADC配列は変更しません。この並びは同梱1.1.0 `FrameReaderSmartar._reshape_data` のbytecodeに記録されたsource-line108の処理との照合に基づきます。新3RXの実機確認は未実施です。

## 取得と解析を分けた記録

- Fsは設定APIの5/2.5 MHzのgetter値です。平均化8/16は別項目です。Fsを平均化数で割った値を作りません。
- uint16 little-endianを元のまま保存します。平均化変更時のfractional bitsとアナログ振幅換算は未確認です。profileごとにこのunknownを残し、dBはuint16保存範囲を基準とする解析値として表示します。
- `source-config.json` に選択要求・SDK生成の宣言値・実読戻しbytes/hash・検証結果を分離して保存します。413個の非校正レジスタとアドレス順を照合し、既存20校正領域の値は保持する一方、意味・読戻し性質はunknownとして検証対象外にします。校正精度の証明ではありません。
- 既存SDKのgetterを静的に追跡した範囲では、Fs/Ns/平均化/gainの取得は非除外レジスタを参照します。ただし全sequence/cache依存を網羅した証明ではありません。413個の一致を、全パラメータの物理適用・ADC coding・平均化振幅換算の証明へ拡張しません。この検証範囲は `device_applied.parameter_verification` に保存します。
- 新RADC0002各packetは全32byteの設定SHA256、CRC、送信連番、callback tickを含みます。セッション中のhash・payload shape変更は拒否します。旧RADC0001も読み込めます。
- ADC metadataはshape/layout、元payload SHA、設定ファイルSHA、設定SHA、PC受信時刻、機器callback時計を保持します。真のADC取得時刻と全機器欠損数はunknownです。連番はMCU送信連番であり、queue_drops=0は完全な欠損計測を意味しません。
- range FFT/STFTは独立した解析設定です。要求値と使用値を保存し、各frame内だけで窓を作ります。通常のframe空白は欠損とは区別します。すべてのスペクトル列・軸・power_db・元bytesの保存再生一致を模擬ADCで検証しています。

## 開発時の生成と制約

`scripts/make-acquisition-profiles.py` は、既存の公式Japan B-step referenceと同梱1.1.0設定APIから10候補を生成します。機器APIやdiscoveryは使用しません。生成ファイルを再読込みし、Ns/Nc/RX/Fs/平均化/gainのgetterと要求を照合し、RF包絡・FIFO・時間・帯域を検査します。公開するのは独自の設定facts/hashのみで、メーカーregister tableはprivate `.runtime` に残します。通常PCでは生成不要です。

`set_frame_rate_Hz(self, frame_rate_hz: float, sequence_idx=None, with_timer=False, timer_idx=0)` の宣言はHz単位、対象sequenceのframe繰返し率です。変更したNs/Nc等との組合せでは要求とgetterの不一致を観測したため、その組合せを採用していません。SDK不具合とは断定せず、原因未分離として独立周期指定を未対応にしています。

FWの独自ソースは `main-config.c` / `radc_config.c`、旧0.2ビルドは変更しない `main.c` です。private tableを `--catalog` で与え、既存公式依存を `--dependency-root` で読み込んでビルドします。アプリからflashは実行しません。[実機適用前のレビュー](ACQUISITION_FW_REVIEW.md)を参照してください。
