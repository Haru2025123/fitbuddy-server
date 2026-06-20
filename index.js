// ======================================================================
// 「ふたりの健康便り」LINEサーバー  index.js
// 自動ペアリング機能つき版 ＋ 連続報告まとめ機能（3秒バッチ）＋ 食事写真の要約転送
// ======================================================================

const express = require('express');
const app = express();
app.use(express.json({ limit: '10mb' }));

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const FIREBASE_URL = 'https://routine-app-88035-default-rtdb.asia-southeast1.firebasedatabase.app';

// 連続報告をまとめる待ち時間（ミリ秒）。3秒。
const BATCH_WAIT_MS = 3000;

// ===== Firebase =====
async function fbGet(path) {
  const res = await fetch(`${FIREBASE_URL}/${path}.json`);
  return res.json();
}
async function fbSet(path, data) {
  await fetch(`${FIREBASE_URL}/${path}.json`, { method: 'PUT', body: JSON.stringify(data) });
}
async function fbDelete(path) {
  await fetch(`${FIREBASE_URL}/${path}.json`, { method: 'DELETE' });
}

// ===== 記録更新 =====
function defaultStats() {
  return {
    haruka: { gym:0, homeGym:0, protein:0, noAlcohol:0, weight:0, skincare:0, cardio:0, streaks:{protein:0,noAlcohol:0,skincare:0}, lastDates:{} },
    yoichi: { gym:0, homeGym:0, protein:0, noAlcohol:0, weight:0, running:0, stretch:0, streaks:{protein:0,noAlcohol:0}, lastDates:{} }
  };
}

function updateRecord(stats, user, text) {
  const r = stats[user];
  if (!r) return stats;
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now()-86400000).toDateString();
  if (text.includes('ジムトレ')) r.gym++;
  if (text.includes('家トレ')) r.homeGym++;
  if (text.includes('体重計測')) r.weight++;
  if (text.includes('プロテイン')) { r.protein++; r.streaks.protein=(r.lastDates.protein===yesterday)?(r.streaks.protein||0)+1:1; r.lastDates.protein=today; }
  if (text.includes('酒なし')||text.includes('禁酒')) { r.noAlcohol++; r.streaks.noAlcohol=(r.lastDates.noAlcohol===yesterday)?(r.streaks.noAlcohol||0)+1:1; r.lastDates.noAlcohol=today; }
  if (text.includes('スキンケア')) { r.skincare=(r.skincare||0)+1; r.streaks.skincare=(r.lastDates.skincare===yesterday)?(r.streaks.skincare||0)+1:1; r.lastDates.skincare=today; }
  if (text.includes('有酸素')||text.includes('ランニング')) r.cardio=(r.cardio||0)+1;
  if (text.includes('ストレッチ')) r.stretch=(r.stretch||0)+1;
  return stats;
}

// ===== ユーザー判定 =====
async function getUserKey(profileName) {
  if (!profileName) return 'haruka';
  if (profileName.includes('晴香') || profileName.toLowerCase().includes('haru')) return 'haruka';
  return 'yoichi';
}

async function getProfile(userId, groupId) {
  try {
    const url = groupId
      ? `https://api.line.me/v2/bot/group/${groupId}/member/${userId}`
      : `https://api.line.me/v2/bot/profile/${userId}`;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${LINE_TOKEN}` } });
    return res.json();
  } catch(e) { return {}; }
}

// ===== Claude API =====
async function callClaude(content) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{ role: 'user', content }]
    })
  });
  const data = await res.json();
  return data.content?.[0]?.text || '最高です！続けてね💪';
}

// ===== LINE返信（reply）=====
async function replyLine(replyToken, text) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LINE_TOKEN}`
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: 'text', text: text.substring(0, 4900) }]
    })
  });
}

// ===== LINE返信（ボタンつきメニュー）=====
async function replyLineMenu(replyToken, text) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LINE_TOKEN}`
    },
    body: JSON.stringify({
      replyToken,
      messages: [{
        type: 'text',
        text: text.substring(0, 4900),
        quickReply: {
          items: [
            { type: 'action', action: { type: 'message', label: '🆕 新規で合言葉を作る', text: '新規' } }
          ]
        }
      }]
    })
  });
}

// ===== LINEプッシュ（push＝相手への通知）=====
async function pushLine(userId, text) {
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LINE_TOKEN}`
    },
    body: JSON.stringify({
      to: userId,
      messages: [{ type: 'text', text: text.substring(0, 4900) }]
    })
  });
}

// ===== LINE画像取得 =====
async function getLineImage(messageId) {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { 'Authorization': `Bearer ${LINE_TOKEN}` }
  });
  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer).toString('base64');
}

// ===== 報告キーワード判定 =====
const KEYWORDS = ['ジムトレ','家トレ','体重計測','プロテイン','酒なし','禁酒','スキンケア','有酸素','ランニング','ストレッチ'];
function buildStatsMessage(stats) {
  const h = stats.haruka, y = stats.yoichi;
  return `📊 現在の記録

🌸 晴香さん
・ジムトレ：${h.gym}回
・家トレ：${h.homeGym}回
・体重計測：${h.weight}回
・プロテイン：🔥${h.streaks?.protein||0}日連続（累計${h.protein}回）
・禁酒：🔥${h.streaks?.noAlcohol||0}日連続（累計${h.noAlcohol}日）
・スキンケア：🔥${h.streaks?.skincare||0}日連続
・有酸素：${h.cardio||0}回

🏋️ 陽一さん
・ジムトレ：${y.gym}回
・家トレ：${y.homeGym}回
・体重計測：${y.weight}回
・プロテイン：🔥${y.streaks?.protein||0}日連続（累計${y.protein}回）
・禁酒：🔥${y.streaks?.noAlcohol||0}日連続（累計${y.noAlcohol}日）
・ランニング：${y.running||0}回

2人とも今日も最高だね！💪✨`;
}
function isReport(text) {
  return KEYWORDS.some(k => text.includes(k));
}

// ===== ペアリング用：4桁の合言葉を作る =====
function genCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}
function welcomeText(name) {
  return `${name}さん、「ふたりの健康便り」へようこそ！🌸

パートナーと記録を共有するための設定をします。

▼ はじめての方
下の「🆕 新規で合言葉を作る」ボタンを押してください。4桁の合言葉が発行されます。

▼ パートナーから合言葉を聞いた方
その4桁の数字をこのトークに送ってください。`;
}

// ===== プロンプト（1件用・複数件用 兼用）=====
function buildReportPrompt(name, text, stats, userKey) {
  const r = stats[userKey];
  const ctx = userKey === 'haruka'
    ? '晴香さんはジムトレ・美容・肉体改造・禁酒に取り組む女性です。'
    : '陽一さんは筋トレと健康習慣に取り組んでいます。';
  return `あなたはトレーニング・美容・ダイエットの専門知識を持つ熱血AIコーチ「FitBuddy」です。
${ctx}
累計記録：ジムトレ${r.gym}回、家トレ${r.homeGym}回、プロテイン${r.protein}回(連続${r.streaks?.protein||0}日)、禁酒${r.noAlcohol}日(連続${r.streaks?.noAlcohol||0}日)、体重計測${r.weight}回
今回の報告：「${text}」
ルール：
- ${name}さんの名前を必ず呼ぶ
- 今回の報告が複数ある場合は、それらをまとめて1つのメッセージで褒める（報告ごとに分けて書かない）
- 毎回まったく違うユニークな比喩・ユーモアを使う（桜、ロケット、伝説の戦士、神話、宇宙、料理、動物、映画など）
- 連続記録・累計が増えたら具体的な数字を出して大げさに褒める
- トレーニングやダイエットに役立つ具体的なアドバイスや豆知識を1つ入れる
- 全体を簡潔にまとめ、2〜4文、絵文字2〜3個、日本語で返答
- 長くなりすぎず、テンポよく読める長さにする`;
}

function buildImagePrompt(name) {
  return `あなたは栄養学とトレーニングの専門家AIコーチ「FitBuddy」です。この食事写真を見て、${name}さんへ以下を必ず全部含めた詳しいメッセージを日本語で書いてください。

【絶対に守るルール】
- 短文・一言コメントは禁止。必ず長文で詳しく書く
- 写真に写っている料理名を具体的に特定する
- 写っている食材（肉・魚・野菜・卵など）を一つひとつ取り上げて、それぞれの栄養素・健康効果・トレーニングやダイエットへの具体的なメリットを詳しく説明する
- 美容・肌・ボディメイクへの効果も具体的に書く
- 推定カロリーを教える
- 毎回まったく違う切り口・表現で書く
- 最後にモチベーションが上がる熱い応援メッセージで締める
- 絵文字を5個以上使う
- 最低でも10文以上書く`;
}

// パートナーへの転送用：短い要約バージョン
function buildImageSummaryPrompt(name) {
  return `あなたは栄養学の専門家です。この食事写真を見て、${name}さんのパートナーに知らせる短い要約を日本語で書いてください。

【ルール】
- 必ず2〜3文の短い要約にする（長文は禁止）
- 写っている料理名を特定する
- 主な栄養素（たんぱく質・野菜など）を一言で触れる
- 推定カロリーを書く
- 絵文字を1〜2個使う
例：「サムギョプサルですね🍖 豚肉中心の高たんぱくメニューで、野菜もしっかり。推定約700kcalです✨」`;
}

// ======================================================================
// ★ 連続報告まとめ機能（3秒バッチ）
// ----------------------------------------------------------------------
// 報告ボタンを連続で押したとき、3秒間ためてから
// ・本人へAI返信を1通にまとめる
// ・パートナーへの通知も1通にまとめる
// ======================================================================
const reportBuffers = {}; // userIdごとに一時保管

function queueReport(userId, name, userKey, text, replyToken) {
  // この人のバッファがまだ無ければ作る
  if (!reportBuffers[userId]) {
    reportBuffers[userId] = { name, userKey, texts: [], replyToken, timer: null };
  }
  const buf = reportBuffers[userId];
  // 最新の情報で更新（replyTokenは毎回いちばん新しいものを使う）
  buf.name = name;
  buf.userKey = userKey;
  buf.replyToken = replyToken;
  buf.texts.push(text);

  // 既存のタイマーをリセットして、3秒後にまとめて処理
  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(() => { flushReports(userId); }, BATCH_WAIT_MS);
}

async function flushReports(userId) {
  const buf = reportBuffers[userId];
  if (!buf) return;
  delete reportBuffers[userId]; // 先に取り出して消す（多重実行を防ぐ）

  try {
    const name = buf.name;
    const userKey = buf.userKey;
    const texts = buf.texts;
    // 「ジムトレ完了・体重計測完了」のように1つにまとめる
    const combined = texts.join('・');

    // 最新の記録を取得してAI返信を作る
    const stats = await fbGet('stats') || defaultStats();
    const reply = await callClaude(buildReportPrompt(name, combined, stats, userKey));

    // 本人へ返信（3秒以内なのでreplyTokenが有効）
    await replyLine(buf.replyToken, reply);

    // パートナーへまとめて通知
    const pair = await fbGet(`pairs/${userId}`);
    if (pair && pair.partnerId) {
      await pushLine(pair.partnerId, `📣 ${name}さんが【${combined}】を報告しました！🎉\nお互い今日も頑張ってるね💪✨`);
    }
  } catch(e) {
    console.error('まとめ処理エラー:', e);
  }
}

// ===== Webhook =====
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  const events = req.body.events || [];
  for (const event of events) {
    try {
      // ▼ 友だち追加されたとき → ようこそメッセージ＋ペア設定メニュー
      if (event.type === 'follow') {
        const userId = event.source.userId;
        const profile = await getProfile(userId, null);
        const name = profile.displayName || 'あなた';
        await fbSet(`users/${userId}`, { name });
        await replyLineMenu(event.replyToken, welcomeText(name));
        continue;
      }

      if (event.type !== 'message') continue;
      const groupId = event.source.groupId;
      const userId = event.source.userId;
      const profile = await getProfile(userId, groupId);
      const name = profile.displayName || 'あなた';
      const userKey = await getUserKey(profile.displayName);
      await fbSet(`users/${userId}`, { name });

      if (event.message.type === 'text') {
        const text = event.message.text.trim();

        // ▼ ペア設定メニューを出す（既に友だちの人用）
        if (text === 'ペア設定' || text === '設定') {
          await replyLineMenu(event.replyToken, welcomeText(name));
          continue;
        }

        // ▼ 「新規」→ 合言葉を発行
        if (text === '新規') {
          const code = genCode();
          await fbSet(`pending/${code}`, { userId, name });
          await replyLine(event.replyToken,
            `🔑 あなたの合言葉は【 ${code} 】です。\n\nこの4桁をパートナーに伝えてください。\nパートナーがこの番号をこのトークに送ると、ペア登録が完了します✨`);
          continue;
        }

        // ▼ 4桁の合言葉が送られた → ペア成立
        if (/^\d{4}$/.test(text)) {
          const pending = await fbGet(`pending/${text}`);
          if (pending && pending.userId && pending.userId !== userId) {
            const partnerId = pending.userId;
            const partnerName = pending.name || 'パートナー';
            await fbSet(`pairs/${userId}`, { partnerId, name });
            await fbSet(`pairs/${partnerId}`, { partnerId: userId, name: partnerName });
            await fbDelete(`pending/${text}`);
            await replyLine(event.replyToken, `🎉 ${partnerName}さんとのペア登録が完了しました！\nこれからお互いの報告がここに届きます💪✨`);
            await pushLine(partnerId, `🎉 ${name}さんとのペア登録が完了しました！\nこれからお互いの報告がここに届きます💪✨`);
          } else if (pending && pending.userId === userId) {
            await replyLine(event.replyToken, `それは自分用の合言葉です😊\nパートナーに伝えて、パートナーから送ってもらってね。`);
          } else {
            await replyLine(event.replyToken, `その合言葉【${text}】は見つかりませんでした。\n番号をもう一度確認してね。`);
          }
          continue;
        }

        // ▼ 記録確認
        if (text === '記録確認') {
          const stats = await fbGet('stats') || defaultStats();
          await replyLine(event.replyToken, buildStatsMessage(stats));
          continue;
        }

        // ▼ 報告以外はスルー
        if (!isReport(text)) continue;

        // ▼ 報告 → 記録だけ先に更新（数字をすぐ正確にする）
        let stats = await fbGet('stats') || defaultStats();
        stats = updateRecord(stats, userKey, text);
        await fbSet('stats', stats);

        // ▼ AI返信とパートナー通知は3秒バッチにためる
        queueReport(userId, name, userKey, text, event.replyToken);
      }

      if (event.message.type === 'image') {
        try {
          const b64 = await getLineImage(event.message.id);
          // 本人へ：詳しい長文の栄養解析（今まで通り）
          const content = [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
            { type: 'text', text: buildImagePrompt(name) }
          ];
          const reply = await callClaude(content);
          await replyLine(event.replyToken, reply);

          // パートナーへ：短い要約だけ転送
          const pair = await fbGet(`pairs/${userId}`);
          if (pair && pair.partnerId) {
            try {
              const summaryContent = [
                { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
                { type: 'text', text: buildImageSummaryPrompt(name) }
              ];
              const summary = await callClaude(summaryContent);
              await pushLine(pair.partnerId, `📣 ${name}さんが食事を記録しました！🍽\n\n${summary}`);
            } catch(sumErr) {
              console.error('食事要約の転送エラー:', sumErr);
            }
          }
        } catch(imgErr) {
          console.error('画像処理エラー:', imgErr);
        }
      }
    } catch(e) { console.error(e); }
  }
});

app.get('/', (req, res) => res.send('FitBuddy is running! 💪'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
