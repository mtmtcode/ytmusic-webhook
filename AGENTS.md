# 開発・保守メモ

## 方針

YouTube Musicの曲情報を任意のWebhookへ送信する汎用Chrome拡張。送信先ごとにURL・認証・JSONテンプレートを設定する。

Chrome Manifest V3 / JavaScript。ビルド、フレームワーク、外部依存は不要。

## 送信先とJSONテンプレート

- 対応変数は `{{title}}`、`{{artist}}`、`{{source}}`。変数はJSONの文字列値に使用する。
- JSONを解析してから変数を展開し、再シリアライズする。曲名内の変数らしき文字列は再解釈しない。
- 未対応変数、構文エラー、キーの変数使用、64KB超、64段を超える入れ子を拒否する。JavaScriptや式は評価しない。
- 送信先は最大20件。認証はなし・Basic・Bearerに対応する。
- URLはHTTP(S)のみ。URL内の認証情報・フラグメント・空白・ワイルドカードを拒否し、リダイレクトには追従しない。
- POSTのHTTP 2xxを成功として扱う。応答本文が空・JSON以外でも受け付ける。
- すべての送信先の接続テストはサンプル曲をPOSTする。OFF状態でも実行でき、入力値は保存しない。

## 動作と状態管理

- Content Scriptで曲情報を監視し、安定した曲変更をService Workerへ報告する。複数タブでは再生中のタブを優先し、同じ曲の連続報告を重複排除する。
- Service Workerで送信を直列に処理し、送信先ごとに状態を管理する。未送信分は最新曲で上書きし、OFF保存時に破棄する。
- 設定・認証情報・復旧情報は `chrome.storage.local` に保存する。Worker起動と定期alarmで未処理分を復旧する。
- 通信はタイムアウトを設け、結果が確定した失敗を回数制限付きで再試行する。配信結果が不明な場合は自動再送を止め、次の曲変更を待つ。

## 権限と認証情報

`storage` と `alarms` を使用する。Content Scriptは `https://music.youtube.com/*` で実行する。送信先への通信権限は `optional_host_permissions` で宣言し、保存・テストするホストごとに取得する。

storageは `TRUSTED_CONTEXTS` に制限し、Content Scriptにはキーやトークンを渡さない。設定操作は拡張のOptions Pageから受け付ける。

## 保存済み設定の移行

設定スキーマはversion 5。拡張バージョンとは別に管理する。旧形式の設定は現行形式に移行する。URL・認証・カスタムテンプレートなどのユーザー設定を維持し、移行は冪等にする。

## 制約

- 受信側のPOSTとローカル状態保存は原子的に確定できない。Worker終了や通信切断などで配信結果が不明になる場合があり、完全なexactly-once配信は保証しない。
- ChromeやPCの終了・スリープ中、タブの破棄・凍結中はDOMを監視できない。バックグラウンドのタイマー抑制で通知が遅れる場合がある。
- YouTube MusicのDOMは非公開仕様のため、UI変更に応じてセレクター調整が必要。複数アーティストは先頭リンクの表示名を使用する。
- 認証情報はローカルに保存し、同期しない。ローカル保存は暗号化保管庫ではない。HTTPの送信先は信頼できるLANで利用する。

## テスト

Node.js 20以降で `npm test` を実行する。依存のインストールは不要。

## 参考：LaMetric TIMEプリセット

LaMetricは送信先設定のプリセットの1つ。端末のローカルDevice APIへ、HTTP Basic認証付きで送信する。

- URL：`http://<ホストまたはIP>:8080/api/v2/device/notifications`
- ユーザー名：`dev`
- パスワード：端末のAPIキー。[デバイス管理](https://developer.lametric.com/user/devices)で取得する。
- 端末へ到達できるLAN等のネットワークと、ホスト権限・ローカルネットワーク許可が必要。
- [公式ドキュメント](https://lametric-documentation.readthedocs.io/)

プリセットのJSON：

```json
{
  "priority": "info",
  "model": {
    "cycles": 1,
    "frames": [
      { "icon": "i1850", "text": "{{title}}" },
      { "icon": "i1850", "text": "{{artist}}" }
    ]
  }
}
```

`cycles` は繰り返し回数（1は1周、0は永続表示）。`icon` はフレームの[アイコンID](https://developer.lametric.com/icons)。これらの固定値はJSONを直接編集する。表示順や既存通知の残り方は端末のキューと通知設定に依存する。

このプリセットの接続テストは認証付きPOSTでサンプル曲のJSONを送信し、実際に通知を表示する。
