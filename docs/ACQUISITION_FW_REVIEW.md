# radc-0.3.0 実機適用前のレビュー

本書はソフトウェア準備時に作成した適用前の提案であり、実施結果の記録ではありません。現機器のFW・取得状態は操作者の記録で確認してください。予算・試行回数・実機操作許可を新たに推定しません。

対象はKITCSKBGT60CUTR13TOBO1 / BGT60CUTR13B（既知ID_HW 0x98185）、MCU CY8C624AFNI-S2D43です。候補は既存と同じBSP/linker/clock/pin構成・公式driver依存からビルドしました。239ソースのcompile/link、ARM emulationでの独自状態制御とpacket一致を確認しました。新FWのbootや新profileの適合は未実証です。

| 項目 | 候補 |
|---|---|
| FW | radc-0.3.0 / RADC_CONFIG_1 / RADC0002 |
| private HEX相対path | `.runtime/csk-config-candidate/csk-raw-main-flash-only.hex` |
| SHA256 | `115de242b421e56aaae6053721b9ee3fe36c7325135e91eb1b483fed687f49c6` |
| HEX data | 78588 bytes、0x10000000..0x10013A2B、155個の512byte main sectorを含む |
| 除外 | SFlash/eFuse/QSPI、保護状態、main以外のHEX data |
| 初期状態 | idle・未設定。INFOのみ可能。SETCONFIG成功とGETCONFIG読戻し一致後だけSTART可能 |
| 最初の候補profile | japan-default：128×1×64、Fs5MHz、Tc501.225µs、frame99.9614375ms、平均化16、gain42dB、2 Mbaud |

新FWでは停止中にprofileを変更でき、UART packet headerが32から64byteになります。旧hostは互換ではありません。新hostは旧0.2の標準取得を維持します。新FWに旧people-tracking検出機能は追加しません。

## 実施するなら必要な最小確認

利用者が取得を停止してアプリを終了した状態で、対象identityと現在mainを既存radc0.2のHEX・保全記録へ照合します。不一致なら理由確認まで停止し、無条件上書きしません。候補は必要なmain sectorだけprogram/verifyし、保護解除や他bank操作は行いません。新FWのINFO・catalog・silicon一致→japan-defaultのSETCONFIG/GETCONFIG照合→短時間取得→停止確認・ポート解放→元bytes/全スペクトル再生検証、の順です。

この最小確認の取得秒数、試行上限、失敗時や成功時の最終FW状態は、実施前に具体的に決める必要があります。本書では新しい数値予算を設定しません。他の9profileは一括成功扱いにせず、それぞれの必要性と試験範囲を別途判断します。

## 既存raw FWへのfallback

既存の実機確認済みradc-0.2.0 HEXは、元の開発フォルダのprivate `.runtime/csk-raw-build-live4/csk-raw-main-flash-only.hex`、SHA256 `90aaad323ddb40785fe7c33ae45929ded5f89d0d7ade3f7dbb9e002f36971605` です。HEX dataは44628 bytes、0x10000000..0x1000B583です。

fallback提案は、保全した現mainも保持したうえで、同じ公式OpenOCD mainflash手順で既存0.2 HEXの必要main sectorをprogram/verifyし、reset後に0.2のINFO・既存profile hashと標準取得を確認するものです。0.3のコードが残る上位main領域は0.2のentry/vectorから参照しない想定ですが、この候補からの復帰書込み・bootは未試験です。全main backupからの復元も読出し/hash一致までで、書込み復元の実証ではありません。部分復帰で不明点が出た場合は保護解除やerase拡大を行わず停止します。

旧people-tracking devFWへの復旧は別の保全backupに基づく別操作です。今回のfallbackと混同しません。private HEX・vendor table・backup・実ADC・画像を公開ZIPへ含めません。
