# Configuration candidate

`main-config.c` + `radc_config.c` adds stopped-only presets (radc-0.3.0). It is built but not programmed or hardware tested. `main.c` retains the 0.2 fixed-profile build. See [candidate operation](../../docs/ACQUISITION_PRESETS.md) and [review before hardware use](../../docs/ACQUISITION_FW_REVIEW.md). Private generated register arrays and firmware binaries are not distributed.

# CSK raw FIFO producer（独自実装）

対象はKITCSKBGT60CUTR13TOBO1のCSK、PSoC6 CY8C624AFNI-S2D43、BGT60CUTR13AIPのB-step向けです。現物のレーダーstepは保存済みID_HW値と同梱定義の照合でBと識別できました。この成果物は独自FWの候補で、既存PC APIの適用可否とは別です。現FWの検出/追跡を置き換えるため、元dev FWのbackup・復元手順と具体的な作業範囲の確認が必要です。現在は[既存PC APIを優先して再確認](../../docs/PC_RAW_API_PATHS.md)し、書換えは保留しています。

`main.c` はidleで起動し、独自`RADC_START\n`で開始、`RADC_STOP\n`でFSMを止めます。設定前にB-stepの既知IDを照合し、不一致では停止します。FIFO/SPI/IRQエラーで停止し、元uint16 bytesをframingしてUARTへ送ります。登録設定の読戻しbytesも送ります。これは既存Infineon UART protocolではありません。

## ビルドの根拠

公式CSK reference commit `f6e9c82b28d0022790b0905201e1d6720615063d` の `src/resource_map.h`、target templateのdesign.modusをピンの根拠に使います。SPIはP5_0/1/2/3、IRQ P9_3、reset P10_5、LDO P8_4、level shifter P10_2、KitProg UART TX/RX P5_5/4です。ソースを転載せず、独立mainからHAL APIで設定します。

full ModusToolbox packageに頼らず、公式同一targetのBSP 4.3.2のstartup/system/CM4 linker、BSP 2.3.0の既存生成済みclock/pin sourceとBSP初期化を使う最小ビルドを用意しました。新PDLが必要とするAHB clock変数は新system実装から提供し、旧生成ソースは旧BSP初期化APIで呼びます。元の参考projectをそのままModusToolboxで再生成したbuildとは異なります。HALがSPI/UARTを初期化し、BSPの100MHz clock設定を使用します。実クロック/baud/電気信号の検証は未実施です。

`scripts/prepare-csk-deps.ps1` が固定commitの公式sourceをprivate runtimeへ取得します。Gitが必要です。compilerは通常npm配布 `@xpack-dev-tools/arm-none-eabi-gcc@14.2.1-1.1.1` のWindows x64 binaryを使用しました。SHA256は `0b2d496b383ba578182eb57b3f7d35ff510e36eda56257883b902fa07c3bba55`。PATHの変更は不要です。

```powershell
.\scripts\prepare-csk-deps.ps1
# .runtime/gcc-arm/<xpack-package>/bin/ にGCC 14.2.1を展開後:
python scripts/build-csk-raw.py
# 128 chirp候補（同梱APIを使うPython 3.11で、機器I/Oなし）:
python scripts/make-csk-raw-profile.py
python scripts/build-csk-raw.py --profile .runtime/csk-profiles/candidate-japan-128x1x64.h --variant csk-raw-build-long128
```

全238 translation unitsからELFとmain flashだけのIntel HEXを生成します。build-reportにはdependency commit、compiler、profileとartifactのSHA256、書込み・boot未確認の状態を残します。生成物は`.runtime/csk-raw-build/`に置き、公開しません。debug情報にlocal pathを含み、vendor objectも含むためです。

HEXは各record checksumを確認し、data addressを`0x10000000..0x101fffff`だけに絞ります。CM0+ sleep imageを先頭8KiBへ、CM4を`0x10002000`以降へ配置する公式linkerを使います。SFlash/eFuse/外部flashは含めません。**HEX生成はboot・programmerによる受入れ・復元の検証ではありません。**

## 独自RADC0001 protocol

32 byte headerはlittle endianです。

|offset|内容|
|---|---|
|0..7|ASCII `RADC0001`|
|8..11|payload byte数|
|12..15|producer packet連番（hardware frame連番ではない）|
|16..19|FIFO処理callbackのMCU ms tick（取得時計ではない）|
|20..23|producerが把握したqueue drop数。全機器欠損ではない|
|24..27|flags、v1は0|
|28..31|CRC32/IEEE。header先頭28 bytes＋payloadが対象|

payloadは元のuint16 FIFO bytes。現在のlayout契約はchirp→RX→sample。CRC不一致・異常byte数・途中frameを拒否し、noiseのskip数とpacket欠番を記録します。元UART streamの別保存には、前後のstatus・register読戻しbytesも含めます。

## PC readerとGUI

通常はアプリの `src/csk-raw-reader.py` → `src/csk-raw.mjs` を使います。INFOのFW版/profile hash/B-step/idleを照合してからSTARTし、433レジスタの要求・実読戻しを保存します。ADC校正領域の既知20読戻し差は意味unknownで保持し、その他の値差は停止します。STOP後にdrain/fsync/closeします。DTR/RTSはfalse、他プロセスのポートを奪いません。

`scripts/make-csk-raw-profile.py` はprivateのprofile/headerと `raw-deployment.json` を生成します。メーカーlibraryの解析はオフラインで、機器を開きません。GUIの実機/合成表示、FFT設定、時計、再生は[実rawガイド](../../docs/DIRECT_RAW.md)を参照してください。旧 `scripts/raw-uart-bridge.mjs` は汎用の手動配信用で、通常GUIに別起動は不要です。

## 実機確認の範囲

`radc-0.2.0` を同じPSoC6 mainへ導入し、実ADC受信・保存・FFT/STFT・GUI開始/停止/再開・COM解放を確認しました。SPI/FIFO raw取得で、検出点の再利用ではありません。boot前の一般clock startupには公式driver initを使い、radar ID確認後にJapan由来profileを適用します。UART HALの一時0byte戻りは有限deadlineで再待機し、無期限waitにしません。

実測とbuild出力を分けます。build-reportの `candidate_only` / 未書込み値は生成時点の属性で、後の導入記録とは別です。アナログ校正精度・frame間位相連続性・長時間は未実証です。元main/work/supervisory flashはprivateに二重read/hash一致で保全していますが、元FW復旧書込みは未試験です。メーカーbinary/profile/backup/実ADCは公開しません。
