# 保存形式とAPIの最小契約

## session-config.json

保存形式版/アプリ版、センサー・基板・FW・driverの識別と由来、転送方式、`requested`、adapterの`applied`、機器の`device_applied`を別記録。ADC sample rate/shape、アンテナ順、chirp/frame周期、周波数、ゲイン、平均化/前処理は未取得なら`unknown`。0.2ではファイル・CSK UART・ローカルWebSocketの`data_kind: detections`に対応。ADC/FFTとセンサー設定書込みは未対応。CSKでは`device_query`にFW/実設定の読取応答を保存する。

## frames.jsonl

1元レコードごとに1行。`receiver_sequence`はPCアプリ側の保存順、`source_line`は元JSONLの物理行番号。headerと不正JSONも記録する。取込み元ファイルは`raw.events.jsonl`でバイトを保持。直接収録では、原文を`message_utf8`に保持した受信envelopeを1行で保存し、PC受信時計とSHA-256を追加する。CSKの解読結果を`decoded_payload`に分け、原文は変えない。

- `data_kind`: `metadata` / `detections` / `event` / `invalid`
- `shape`: 検出行数 × 属性数。ADCのchirp/RX/sample形状ではない。
- `attributes` / `data`: 元検出結果の属性順を保持。
- `source_packet_sequence`: 初版では意味を確認できないため`unknown`。
- `target_sequence_nums`: 元検出対象のsequence_num。packet連番として扱わない。
- `device_time`: 明示された`{value,unit,basis}`があれば未検証の宣言として保持。それ以外はunknown。
- `pc_receive_time`: 同梱1.1の文字列tsを復元したms / Unix epoch UTC / PC解読時刻。
- `replay_import_time`: このアプリがファイル行を読んだms / Unix epoch UTC。元受信時刻ではない。
- `diagnostic_log_time`: 選択された既存デバッグログのローカル時刻・timezone。取得時計ではない。
- `missing`: 機器packet欠損と物理収録欠損はunknown、元のframes_droppedがあれば別保存。
- `errors`, `raw`, `raw_line_sha256`, `record_sha256`: 元レコード・エラー・保存整合性。

## manifest.json / training.json

manifestは状態、durable cursor、時間範囲、元データ/video/configのSHA-256、同期とその履歴、ラベルとレビュー履歴を保持。ラベルの`origin`は`manual` / `automatic_candidate_import`、`status`は`pending` / `confirmed` / `corrected` / `rejected`。レビュー更新には`expected_revision`を要求し、`request_id`で同じ操作を再送しても重複しない。

training.jsonには確認/修正済みの同期できた区間のみを含め、除外区間には理由を付ける。区間境界は`[start,end)`。動画境界、対応レーダー境界、目印由来の不確かさ、外挿、対応した保存連番、被験者/セッション/シナリオ/分割グループ、制約、整合性結果を含める。raw ADCの学習入力や自動分割済みdatasetを作ったとは扱わない。

## localhost HTTP

GUIが`GET /api/bootstrap`で起動ごとのtokenとcapabilitiesを取得する。POSTの`x-radar-token`はローカルGUI用の一時tokenで、外部APIキーではない。

| 操作 | パス |
| --- | --- |
| 一覧/新規作成 | GET / POST `/api/sessions` |
| 合成デモ | POST `/api/demo` |
| セッション | GET `/api/sessions/<id>` |
| JSONL受信 | POST `/api/sessions/<id>/radar?name=<file>&format=jsonl`、bodyは元バイト |
| 既存診断JSON受信 | 同じパスで`format=diagnostic` |
| 動画受信 | POST `/api/sessions/<id>/video?name=<file>`、bodyは元バイト |
| 読込み開始/停止 | POST `/api/sessions/<id>/start` / `stop`、JSON `{}` |
| フレーム/設定/整合性 | GET `/api/sessions/<id>/frames` / `configuration` / `verify` |
| 動画/ブラウザー報告metadata | GET `video`、POST `video-metadata` |
| 2つの同期目印 | POST `/api/sessions/<id>/sync` |
| 区間追加/レビュー | POST `/api/sessions/<id>/labels` / `labels/<labelId>` |
| 対象動画hash付き候補取込み | POST `/api/sessions/<id>/candidates` |
| 自動モデル入口 | POST `/api/sessions/<id>/auto-label` は501未実装 |
| 書き出し | GET `/api/sessions/<id>/export?format=archive` / `json` / `csv` |

bindは127.0.0.1のみ。CSKは別プロセスのインストール済みメーカーAPI、WebSocketはlocalhostのテキストイベントを受信する。UDPは未対応。


## 0.2の直接収録API

`mode: live`でセッションを作成し、以下の操作を行う。

| 操作 | POSTパスと入力 |
| --- | --- |
| カメラ時計登録・レーダー接続 | `capture-start`。`transport`、CSKの`port`またはWebSocketの`url`、`data_kind: detections`、`camera`、`request_id` |
| 画面生存確認 | `capture-heartbeat`。JSON `{}` |
| 動画分割保存 | `camera-chunk?index=<0始まりの連番>&end_ms=<ブラウザー単調時計>`。bodyは元WebMバイト |
| レーダー停止 | `stop`。JSON `{}` |
| 動画結合と収録終了 | `capture-finish`。`expected_chunks`、`stopped_monotonic_ms`、`stopped_unix_ms` |
| カメラエラー | `capture-error`。`message` |

`camera`にはWebMの`mime_type`、`started_unix_ms`、`started_monotonic_ms`、`time_origin_ms`、取得できたwidth/height/frame_rateを登録する。時計はブラウザーcallback由来で露光時刻ではない。音声は要求しない。

`manifest.capture`は動画分割の連番、元バイト長とSHA-256、callback時計、開始終了時計、中断と空白、上限を保存する。`camera-chunk-XXXXXX.webm`はdurableな元分割、`video-live.webm`は確認後に結合した動画。分割の再送は同じ連番・hash・callback時計なら冪等で、異なる内容や連番飛びは拒否する。

ライブframeの`source_pc_decode_time`は元のtsから得た時計、`pc_receive_time`はこのアプリ/bridgeの受信callbackのUnix ms。`pc_receive_monotonic_time`はNodeまたはbridgeプロセスの単調nsで、そのbasisを明記する。元のts=0は機器時刻へ推定しない。

直接収録では停止したセッション内の追記再開を拒否する。新セッションの`capture.resumed_from`に前のIDを残し、空白を別収録として保持する。中断時のdurable受信envelopeは復旧可能だが、未保存行や未保存動画の完全性は保証しない。完成には有効な検出イベント、動画分割の照合と結合が必要。ソフト時計の一致で同期目印を自動確定しない。
