# CSK raw FWの導入記録と元FWの復旧

2026-10-22、本人の「機能がなければ追加し、生データからリアルタイム描画まで」の明示指示に基づき、同一個人PC・同一kitへ独自raw FWを導入しました。元の検出FWはprivate backupに保持しています。アプリ起動・通常の開始/停止はflashを書きません。

## 現在のartifactと対象

- FW: `radc-0.2.0` / protocol `RADC0001`
- private HEX: `.runtime/csk-raw-build-live4/csk-raw-main-flash-only.hex`
- SHA256: `90aaad323ddb40785fe7c33ae45929ded5f89d0d7ade3f7dbb9e002f36971605`
- 対象: KITCSKBGT60CUTR13TOBO1、実MCU CY8C624AFNI-S2D43、main 2MiB、protection NORMAL。radar ID_HW=0x00098185（B-step）を設定前に照合。
- HEX data 44628 bytes、`0x10000000..0x1000B583`。programmerのsector paddingは45056 bytes。main以外のdataを除外し、checksum/vector/addressを監査。SFlash/eFuse/QSPI/保護状態は変更していません。
- profile: 128chirp×1RX×64sample、Fs5MHz、Tc501.225µs、frame99.9614375ms、ADC averaging16、2Mbaud8N1。[時計・軸・制限](DIRECT_RAW.md)を参照。

最終状態はraw FW、取得停止・COM解放です。通常使用は[起動手順](DIRECT_RAW.md)によります。従来の検出・追跡UARTとは互換ではありません。

## 実施と範囲

元main 2MiBを保存済みbackupと実flashで全verifyしてから、必要なmain sectorだけprogram/verifyしました。初期化のUART backpressure、HAL interface pin、sensor clock startupを修正し、計4回のmain program/verifyを実施しました。最初の3候補はSTART前の識別で停止しADC0でした。4番目で実ADC取得に成功しました。復旧書込みは未試験です。

最初の実取得はSTART→STOP約5.294秒・53frame。GUIの短い確認は10frame/約1.053秒、早すぎるテストSTOPで0frame/約0.089秒、修正後の再開9frame/約0.959秒です。GUIの失敗は待機条件・文言期待の誤りとして修正し、0frameを成功件数に含めません。実ADCは合計72frame、START→STOP合計約7.395秒（0frameの約0.089秒を含む）です。要求の5秒＋必要な短い再試験の範囲で実施し、人間が指定した累積時間/試行数の数値上限は未設定でした。長時間試験・学習は行っていません。

## 元FWの保全

元は `indoor_people_localization 0.4.5.dev0+g2b14fe4.d20260212` / sensor_driver0.5.12です。許可されたSWD readでmain2MiB、work32KiB、supervisory flash32KiBを各2回privateに保存し、各bankの全bytes/hash一致を確認しました。読出し後の元FW起動・GET・検出・disconnectは確認済みです。QSPI/eFuse/RAMはbackup対象外です。

保全ファイルはローカルの `evidence/private-backup-20261021/` にあります。Gitには含めません。mainの現在候補を書き戻す操作と、元mainを復旧する操作を区別してください。work/supervisory flashはこのraw FWで書きません。元register dumpの動的/校正/SEQ_BUFFER等には差があり、全実設定の完全復元を主張しません。

## 復旧する場合の手順（今回は未実行）

1. アプリで取得を停止し終了します。他アプリがポート使用中なら作業しません。対象kit/MCU、元backup2ファイルの長さ・hash一致を確認します。
2. 今回使用した公式OpenOCDの `interface/kitprog3.cfg` と `target/infineon/cy8cxxa.cfg` を使い、`ENABLE_ACQUIRE=0` / `ENABLE_POWER_SUPPLY=0` にします。`init` 後、CM0/CM4を有限timeoutでhaltし、`psoc6_main_cm0` をprobeしてmain bankだけを対象にします。
3. 既知の元mainを `flash write_image erase <private-main-1.bin> 0x10000000 bin`、続けて `verify_image <private-main-1.bin> 0x10000000 bin` で照合します。アドレス範囲は `0x10000000..0x101FFFFF` のみです。
4. `reset run; shutdown`、元FWの版/GET/検出を確認して切断します。保護解除・全chip erase・別領域書込みへ広げません。verifyが失敗したら停止して原因を確認します。

元FWの完全な再書込み復帰はまだ実証していません。backup read/hash一致を復旧成功と同一視しません。この手順はレビュー用で、開始時のアプリが自動実行する機能ではありません。
