# CSK raw FIFO producer（未書込み候補）

対象はKITCSKBGT60CUTR13TOBO1のCSK、PSoC6 CY8C624AFNI-S2D43、BGT60CUTR13AIPのB-step向けです。現物のレーダーstepは未読出しです。現行FWの機能を追加するPC設定ではなく、独自FWの候補です。現FWの検出/追跡を置き換えるため、元dev FWのbackup・復元手順と本人の明示的な書込み承認が必要です。

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

## PC bridge

現行stock FWへは使えません。書込み・boot・profile/step適合・原設定読戻しが確認された候補FWだけが対象です。これは現在まだ未実施の段階です。

```powershell
node scripts/raw-uart-bridge.mjs --candidate-firmware-confirmed `
  --python <pyserialのあるpython.exe> --port COM10 `
  --header <実設定とtimingを記したprivate-header.json> `
  --raw-wire-file <新規private-wire.bin> --start-stop
```

表示されたloopback URLとheaderをraw画面へ入力します。WebSocket client接続時にCOMを開きます。使用中なら失敗し、既存アプリを閉じません。DTR/RTSはfalseに設定し、break/resetは送りません。`--start-stop`はこの独自main向けの既知コマンドだけを送ります。停止はchildへ終了を通知し、STOP送信・wire fsync・closeを待つ設計です。2秒で終われないときの終了fallbackまで、実機では未確認です。

callback時計に合わせてframeを置き、frame内は宣言されたTcを使います。frame原点の物理遅延はunknownです。ADC full-scale・coding・FIFO順序・readback metadataは実機で確認してheaderへ記載する必要があり、sourceの宣言だけでhardware verifiedにしません。

## 書込み前の残件

1. 公式debugのattach/halt/resetが現稼働を一時中断する可能性を確認し、許可された範囲でbackup可否と保護状態を読む。backupはprivateに保存する。
2. 現dev FWのmain/work/user settings等、復元に必要な範囲を特定し、複数readのhash一致と元FW情報を照合する。保護領域の解除やeraseは行わない。現時点で完全backup・復元可能とは言えない。
3. silicon step・profile・baud余裕・metadata・boot/stopの確認計画を提示し、本人の具体的な書込み承認を得る。
4. 書込み後に原bytes、readback設定、timing/shape/欠損、連続STFTを実測検証し、終了時の復帰を検証する。

許可なしのFW書込み、erase、保護変更を行うスクリプトは含みません。

## 今回のprivate artifactとbackup調査

128chirp候補のHEXは生成済みです。SHA256とprofile、書込み/復帰の未承認手順、試験後の状態選択は[raw pilot手順案](../../docs/MICRO_DOPPLER_PILOT.md)にまとめました。

本人が別途許可したbackup読取りは実施済みです。実MCU CY8C624AFNI-S2D43/protection NORMALを確認し、約11秒でmain 2MiB/work 32KiB/SFlash 32KiBを各2回読み、bytes/hash一致を確認しました。reset run後に同じ元FW版と検出出力へ戻り、disconnectしました。metadataと低位register範囲は一致した一方、校正/MD/SEQ_BUFFER等の全register一致は確認できません。復元書込みと実機raw/boot試験は未実施です。上の残件にあるbackup調査部分はこの範囲まで進んでいますが、完全な復元保証を意味しません。
