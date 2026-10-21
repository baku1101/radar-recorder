# 実測rawへの切替試験案（書換え保留・未実行）

目的は、現物KITCSKBGT60CUTR13TOBO1でADC FIFO→元bytes保存→range FFT/STFT→連続画面更新を実証し、普段使えるraw取得経路を用意することです。ここまでのスペクトル試験は合成で、実測rawは0件です。

## 準備した候補

- private HEX: `.runtime/csk-raw-build-long128/csk-raw-main-flash-only.hex`
- SHA256: `898377ea2c1edcd47f7e4f185b88ebe699764c1e306d207dc7b026f3c3f10904`
- 対象MCU: 実機SWDでCY8C624AFNI-S2D43、main flash 2MiB、protection NORMALを確認。公式同一part/BSPのstartup/linkerを使用。
- HEX data: 41444 bytes、`0x10000000..0x1000A913`。独立監査で全record checksumとCM0+/CM4 vector、CM4 Reset_Handlerの整合を確認。SFlash/eFuse/QSPI向けdataなし。実機bootは未確認。
- profile: 公式Japan profileから同梱HALでオフライン生成したB-step候補。128 chirp×1RX×64 sample、ADCの16回平均を維持、Fs 5MHz、Tc 501.225µs、約99.9614375ms/frame。保存済みID_HW値と同梱定義から現物をB-stepと識別。候補FW自身も設定前のID不一致なら停止。
- 128点窓64.1568ms、15.586812Hz/bin、約0.0384449m/s/bin、Nyquist約±2.46047m/s。窓とframe間gap約35.8046msをつながない。これはbin間隔で、分離性能の実証ではない。
- UART 2Mbaud 8N1、約164.2kB/s、理論上限の82.1%。連続伝送の余裕・ADC coding/位相安定性・RF/clock実値は未確認。

profileは未適用です。1RXなので角度推定を提供しません。現FWの検出/追跡イベントはこの候補FWでは提供しません。検出点グラフと従来の検出点収録を使う場合は元FWへ戻す必要があります。

## 既存FWの保全と限界

許可されたbackup調査で、main 2MiB・work 32KiB・SFlash 32KiBをhalt下で各2回privateへ読み、各bank全bytes/hash一致を確認しました。読出し約11秒後にreset runし、元FW同一版のGET、検出6件、disconnectを確認しました。FW書込み・erase・保護変更はしていません。

metadata、registerの件数/順序と0x0004〜0x1BFFの読戻し値は一致しました。ADC校正・MD status/target/test・SEQ_BUFFERを含む305項目は不一致です。SEQ_BUFFER差の原因はunknownで、全設定の完全復元とは主張しません。backupには外部QSPI・eFuse・RAMを含みません。実際にbackupを書き戻した復元試験も未実施です。

## 承認を得てから行う範囲

1. 元backupと候補HEXのhashを再照合し、ポートを使用するアプリがある場合は中止する。
2. 公式OpenOCDでmain flashの必要sectorだけをerase/program/verifyする。SFlash/eFuse/QSPI・保護状態は変更しない。これはbackup読取りとは別のFW変更操作で、最終FW状態も含めて本人が選択した範囲に限定する。
3. reset後に独自FWのidle応答とsilicon ID照合を確認し、既知の`RADC_START`で上記raw profileを適用する。カメラなしで5秒記録し、CRC・shape・連番/欠損、元bytes、設定読戻し、timing、STFT連続更新と保存再生を確認する。実測であることと、動作識別ができたかを分けて報告する。
4. STOP・port解放。異常時は試験を打ち切り、保全した元main imageの`0x10000000..0x101fffff`を書き戻してverify、reset、元FW版/出力を確認する。work/SFlashは候補FWが書かない設計で、追加書込みを前提にしない。復帰できない場合もerase/unlock/保護解除へ広げず停止する。

## 最終状態の選択

本人に、試験後の状態も含めて選択してもらいます。

- **試験後に元FWへ戻す**: raw取得を短時間検証してから元mainを復元する。復元書込み自体の実証も得るが、普段の画面は元の検出点取得へ戻る。
- **復元を確認したうえで、成功時はraw FWを維持する**: 5秒試験→元FW復元確認→成功時に同じ候補を再適用する。以後micro-Doppler用rawを取得できる状態を目指す。従来の検出/追跡は使えなくなる。これらのmain flash erase/programを含めて事前に承認を得る。
- **今は書き換えない**: 現FWを維持し、実測raw未達成のまま、ソフトと候補artifactを保管する。

現在は既存公式PC APIと現FWのraw出力条件を再確認するため、書換えを保留しています。最終FW状態を含む具体的な作業範囲が確定する前には実行しません。build成功・backup読出し成功を、raw実測や復元書込みの成功にしません。[取得経路の再確認](PC_RAW_API_PATHS.md)を参照してください。
