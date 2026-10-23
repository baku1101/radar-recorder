# Windows 10/11でのセットアップ

取得条件切替候補0.7.0-rc.2も同じ専用runtimeで動作します。別フォルダへ配置し、[候補版手順](ACQUISITION_PRESETS.md)に従ってください。setupは新FWを導入しません。旧0.2では標準取得のみ有効で、新0.3の実機適用は未実施です。stable配布物を上書きしません。

64bit x64版のWindows 10/11、Windows PowerShell 5.1、ChromeまたはEdgeを使います。別PCでは、**すでに `radc-0.2.0` を導入した同じKITCSKBGT60CUTR13TOBO1** をUSBで接続して使う手順です。通常の検出FWや新品キットへのFW導入を、このセットアップは行いません。

## 最初の3手順

1. Windows配布ZIPを右クリックして「すべて展開」し、書込可能な任意のフォルダへ置きます。空白・日本語を含むパスに対応します。Program Files等の管理者用フォルダや、ZIPを開いたままの実行は避けてください。
2. `setup.cmd` をダブルクリックします。専用Node/Python/pyserialをアプリ内へ配置します。オンライン版は初回約51MBのHTTPSダウンロード、offline版は同梱の固定packageを使います。管理者権限、既存Node/Python、メーカーVisualization Toolは不要です。
3. `start.cmd` を実行します。任意の `doctor.cmd` でPC側の依存・設定を確認することもできます。表示された `http://127.0.0.1:8765` をChrome/Edgeで開いてください。サーバーのウィンドウは使用中そのまま残します。

ブラウザの「生ADCから算出するmicro-Doppler」で「CSK 生ADC（専用raw FW）」を選び、「このPCのCOM一覧」で一覧からキットのCOMを選んで（手入力も可能）、「接続して実raw表示・保存を開始」を押します。別PCではCOM10とは限りません。ボタン直下の状態とframe数が変化します。「raw取得/処理を停止」で保存とCOM解放を待ちます。再度開始すると別セッションになります。停止した記録は選択して再生・読戻し検証・書出しができます。

COM番号はWindowsのデバイスマネージャー「ポート(COMとLPT)」で確認します。任意の `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\doctor.ps1 -ListPorts` はCOMを列挙するだけで、ポートを開きません。COMが見つからない場合、未接続・USBケーブル・driverをこの結果だけでは区別できません。KitProg3の認識は[メーカーのKitProg3配布・案内](https://github.com/Infineon/KitProg3)とWindowsデバイスマネージャーで確認してください。セットアップからdriver導入やKitProg更新を自動実行しません。

## 保存・更新・終了

収録データはアプリ内の `data/sessions` に保存します。書込可能な別フォルダを使う場合は `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start.ps1 -DataDirectory 'D:\Radar Data'` と指定できます。`-Port 8876` でポートも変更できます。

同じポートで既にサーバーが動いていると、新しいサーバーを開始せず、実行中/ファイル側の版を案内します。取得を停止して保存・COM解放を待ち、元のサーバーウィンドウでCtrl+Cを押してから起動し直してください。他のアプリを自動終了しません。更新後はブラウザをCtrl+F5で再読込します。

更新は、旧アプリで取得を停止して終了後、新ZIPを**別フォルダ**へ展開しsetup/doctorを実行します。旧フォルダは残し、必要なら同じ `-DataDirectory` を指定します。同じ保存先を複数サーバーで同時使用しないでください。セットアップ自身は既存データ・旧 `.runtime/csk-profiles`・ローカル設定を上書きせず、lockごとの別runtimeと参照先だけをアプリ内に作成します。再実行可能です。削除は取得停止・アプリ終了後にフォルダ単位で行えます。残したいデータを先に保全してください。

## 依存と確認範囲

`windows-runtime.lock.json` にNode 24.22.1、Python 3.14.9 embedded x64、pyserial 3.5のURL/SHA256を固定しています。取得元はnodejs.org、python.org、PyPIのfiles.pythonhosted.orgのみです。ダウンロードは実行前にSHA256を確認します。Nodeは公式SHASUMS、Pythonは公式Sigstore bundle内のSHA256、pyserialはPyPIメタデータのSHA256に照合して固定しました。セットアップはSigstore署名検証器ではありません。lockとスクリプト自体は信頼できる配布元から受け取ってください。

埋込Pythonは隔離された `._pth` でアプリ内のpyserialだけを追加し、pip・global site-packages・ユーザーPATHを変更しません。旧検出FW向けのメーカーAPI機能は別途Visualization Toolが必要ですが、専用rawFWのADC取得・FFT/STFT・表示/保存/再生には不要です。

同梱 `profiles/radc-0.2.0-japan128.json` は独自に記述したshape/timing/符号化と生成profileのhashです。メーカー設定配列、実機dump、個体校正値、FW binaryは含みません。開始時はFW識別・profile header hash・433個のアドレス順・校正領域を除く413個の値のfingerprintを確認します。照合値は生成profile初期値から作成し、実測dumpから作っていません。校正領域20項目の読戻しは保存し意味をunknownのまま残します。PCからregisterを書き込みません。不一致なら停止します。新規/別FWへの対応保証ではありません。

同一Windows PC上で、空白/日本語パスのfresh directory、Windows PowerShell 5.1、global Node/Pythonとメーカーlibを使わない条件でsetup→doctor→mock HTTP・開始/停止/再開・保存検証・二重起動拒否を試験します。このセットアップ検証では実機COMを開きません。別PC/Windows 10実機での検証、driver導入、FW導入は未実施です。実機ADCの数値/物理時刻・速度方向の限界は[取得結果](DIRECT_RAW_COMPLETION.md)も参照してください。

## 問題が起きたら

- setupがSHA256不一致：表示されたpackageを再取得します。不一致ファイルを実行しません。offline版ならZIPを配布元から取得し直してください。
- HTTPSが失敗：ネットワーク/組織の制限を確認するかoffline ZIPを使います。Windowsの証明書・セキュリティ設定をセットアップが変更することはありません。
- doctorが専用runtimeなし：ZIP全体を展開してsetupを先に実行します。端末を使う場合は `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1` です。永続ExecutionPolicy変更は不要です。
- FW識別/profile不一致：通常検出FWをこのraw経路では使えません。[FW準備・復旧条件](MICRO_DOPPLER_PILOT.md)を確認します。PCのセットアップを繰り返してもFWは変わりません。
- COM使用中：そのポートを利用する元アプリ側で終了してください。このアプリは接続を奪いません。

## 配布物の生成

開発者はソースをGitに追加してprivacy auditを通した後、`scripts/package-windows.ps1 -OutputDirectory <出力先> -CacheDirectory <固定packageのフォルダ>` でonline/offline ZIPを作れます。追跡ファイルだけを列挙し、private directory/ADC/FW binaryを拒否します。offline版に追加するのはlockに一致する公式依存archive3個だけです。pyserialの公式ライセンス原文はsource内にも保持します。`DISTRIBUTION.json` にsource commit・ファイルhash一覧を、ZIPの隣にSHA256を保存します。
# <a id="proxy"></a>Windows登録済みproxyで407になる場合（0.6.1以降）

Gitから取得したフォルダでは、取得・アプリを終了してから更新し、次を実行します。セットアップが失敗してアプリをまだ起動していなければ、そのまま更新できます。

```powershell
git pull --ff-only
.\setup.cmd -UseSystemProxy -ProxyUseDefaultCredentials
.\doctor.cmd -NetworkOnly -UseSystemProxy -ProxyUseDefaultCredentials
```

Windowsのインターネットオプションに登録された手動proxy・自動検出・PACをOS/.NETへ解決させます。`-ProxyUseDefaultCredentials` は利用者の明示選択で、現在のWindowsアカウントをproxyのNegotiate/NTLM/Kerberos応答だけに使います。配布元向けの `UseDefaultCredentials` は無効で、Basic認証へ現在ユーザーの資格情報を渡しません。パスワードprompt、Credential Manager読出し、資格情報の保存はありません。会社の実proxy・実PAC・実統合認証は未検証です。407というエラーだけでは、そのproxyがこれらの方式に対応するか判定できません。

毎回指定せずアプリ内に選択を保存する場合は、`setup-proxy.cmd` を実行するか、次を使います。保存するのはproxyの選択と認証方式だけです。Windowsやネットワークの設定を変更しません。

```powershell
.\setup-proxy.cmd -UseSystemProxy -ProxyUseDefaultCredentials
.\setup.cmd
```

手動proxyを指定する場合の例です。実際のホスト名・portは社内ITの案内に従ってください。ユーザー名・パスワード・tokenをURLへ含めないでください。userinfo/path/query/fragmentを含む入力は、値を表示せず拒否します。

```powershell
.\setup.cmd -Proxy http://proxy.example.invalid:8080 -ProxyUseDefaultCredentials
```

選択の優先順位は、明示した `-Proxy` / `-UseSystemProxy` → アプリ内 `setup-network.local.json` → `HTTPS_PROXY` → `HTTP_PROXY` → Windows既定設定です。認証は指定しなければ無効です。環境変数からproxyを採用した場合のみ、`NO_PROXY` のcomma区切りhost/domain[:port]、`*`も使います。明示指定とアプリ内設定は環境のbypassを引き継ぎません。環境変数自体やOS設定は書き換えません。

Node/Python/pyserialの全取得に同じpolicyを使い、ダウンロード後は固定SHA256を検査します。失敗した一時ファイルだけを除去し、既存runtimeの参照は変更しません。proxy拒否時にdirect接続や別mirrorへ切り替えません。offline ZIP／`-Offline`ではネットワークとproxy設定を使用しません。ローカル設定ファイルはGit・配布ZIPから除外します。

| 表示 | 次の確認 |
|---|---|
| `SETUP_PROXY_AUTH_REQUIRED` / 407 | 上のWindows統合認証指定を確認。残る場合、Basic専用・別方式・権限不足などを社内ITへ確認。パスワードをチャットへ送らないでください。 |
| `SETUP_NETWORK_TLS` | 社内証明書・配布先の許可をITへ確認。SSL検証を無効化したり、証明書を自動導入したりしません。 |
| `SETUP_NETWORK_DNS` / `CONNECT` | proxy名・接続先の到達性・社内の接続許可を確認。 |
| `SETUP_NETWORK_TIMEOUT` | 応答時間切れ。正常なcache/runtimeは保持します。 |
| `SETUP_NETWORK_HTTP` | 表示されたHTTP statusと接続許可を確認。応答本文や認証headerは表示しません。 |

`doctor -NetworkOnly` は設定選択の確認だけで、接続・認証の成功試験ではありません。パスワードが必要なBasic専用proxy等には、この機能だけで対応したとは言えません。会社の許可に従ってITへ確認するか、許可されたoffline配布物を利用してください。

Microsoftの根拠：[GetSystemWebProxy（現在ユーザーの自動検出/PAC/手動設定）](https://learn.microsoft.com/en-us/dotnet/api/system.net.webrequest.getsystemwebproxy?view=netframework-4.8.1)、[proxyのCredentialsと407](https://learn.microsoft.com/en-us/dotnet/api/system.net.webproxy.credentials?view=netframework-4.8.1)。実装はPS5.1の.NET Framework HttpClientHandlerを使用し、originとproxyの資格情報を分離しています。
