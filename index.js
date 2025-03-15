import { Telegraf } from 'telegraf';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Cấu hình Firebase Admin SDK
let firebaseApp;
try {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : require('./firebase-service-account.json');

  firebaseApp = initializeApp({
    credential: cert(serviceAccount),
  });
} catch (error) {
  console.error('Error initializing Firebase Admin SDK:', error);
  process.exit(1);
}

const db = getFirestore(firebaseApp);

const MIN_MCAP = 72000; // 50K USD
const MAX_MCAP = 260000; // 350K USD
const TOKEN_RETENTION_DAYS = 7; // Lưu token trong 7 ngày

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MORALIS_API_KEY = process.env.MORALIS_API_KEY;

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

async function loadPostedTokens() {
  try {
    console.log('Loading posted tokens from Firestore...');
    const now = new Date();
    const cutoffDate = new Date(now.getTime() - TOKEN_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    const tokensRef = db.collection('posted_tokens');
    const snapshot = await tokensRef.get();

    const tokensMap = new Map();
    let removedCount = 0;

    for (const doc of snapshot.docs) {
      const token = doc.data();
      const tokenDate = new Date(token.timestamp);

      if (tokenDate >= cutoffDate) {
        tokensMap.set(token.address, {
          timestamp: token.timestamp,
          initialMcap: token.initialMcap || 0,
          telegramMessageId: token.telegramMessageId || null,
          maxMultiplier: token.maxMultiplier || 1,
        });
      } else {
        removedCount++;
        await tokensRef.doc(doc.id).delete();
      }
    }

    console.log(`Loaded ${tokensMap.size} valid tokens from Firestore`);
    if (removedCount > 0) {
      console.log(`Removed ${removedCount} old tokens from Firestore`);
    }
    return tokensMap;
  } catch (error) {
    console.error('Error loading posted tokens from Firestore:', error);
    return new Map();
  }
}

async function savePostedTokens(postedTokensMap) {
  try {
    console.log('Saving posted tokens to Firestore...');
    const tokensRef = db.collection('posted_tokens');
    const batch = db.batch();

    for (const [address, data] of postedTokensMap) {
      const tokenDoc = tokensRef.doc(address);
      batch.set(tokenDoc, {
        address,
        timestamp: data.timestamp || new Date().toISOString(),
        initialMcap: data.initialMcap || 0,
        telegramMessageId: data.telegramMessageId || null,
        maxMultiplier: data.maxMultiplier || 1,
      }, { merge: true });
    }

    await batch.commit();
    console.log(`Successfully saved ${postedTokensMap.size} tokens to Firestore`);
  } catch (error) {
    console.error('Failed to save posted tokens to Firestore:', error);
    throw error;
  }
}

async function fetchTokens() {
  try {
    console.log('Fetching graduated tokens from Moralis API for Pump.fun...');
    const options = {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'X-API-Key': process.env.MORALIS_API_KEY,
      },
    };

    const exchange = 'pumpfun';
    const response = await fetch(`https://solana-gateway.moralis.io/token/mainnet/exchange/${exchange}/graduated?limit=20`, options);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    console.log('Raw Moralis API response:', JSON.stringify(data, null, 2));
    if (!data?.result) {
      console.log('No data returned from Moralis API');
      return [];
    }

    const validTokens = data.result.filter(token => {
      const isValid = token.tokenAddress && token.graduatedAt;
      if (!isValid) {
        console.log(`Invalid token: ${JSON.stringify(token)}`);
      }
      return isValid;
    });
    if (validTokens.length !== data.result.length) {
      console.log(`Filtered out ${data.result.length - validTokens.length} invalid tokens (missing tokenAddress or graduatedAt)`);
    }

    const sortedTokens = validTokens.sort((a, b) => new Date(b.graduatedAt) - new Date(a.graduatedAt));
    console.log('Moralis API response - Graduated tokens (sorted by graduatedAt):', sortedTokens);

    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 1 * 60 * 60 * 1000);
    const recentTokens = sortedTokens.filter(token => {
      const graduatedAt = new Date(token.graduatedAt);
      return graduatedAt <= now && graduatedAt >= oneHourAgo;
    });

    console.log(`Found ${recentTokens.length} tokens graduated within the last hour`);
    const tokens = recentTokens.map(token => token.tokenAddress);
    console.log(`Fetched ${tokens.length} unique tokens from Moralis (newest first)`);
    return tokens;
  } catch (error) {
    console.error('Error fetching data from Moralis:', error);
    return [];
  }
}

async function fetchDexData(address) {
  try {
    if (!address) {
      throw new Error('Token address is undefined');
    }
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
    const data = await response.json();

    if (!data?.pairs?.length) return null;

    const tokenInfo = data.pairs[0];
    const mcap = parseFloat(tokenInfo.fdv) || 0;

    const socialLinks = [];
    if (tokenInfo.info?.websites?.length) {
      tokenInfo.info.websites.forEach(site => socialLinks.push(site.url));
    }
    if (tokenInfo.info?.socials?.length) {
      tokenInfo.info.socials.forEach(social => socialLinks.push(social.url));
    }

    return {
      address,
      imageUrl: tokenInfo.info?.image || tokenInfo.baseToken?.image || '',
      symbol: tokenInfo.baseToken?.symbol || 'N/A',
      name: tokenInfo.baseToken?.name || 'Unknown Token',
      mcap: mcap,
      socialLinks: socialLinks,
    };
  } catch (error) {
    console.error(`Error fetching Dexscreener data for ${address || 'undefined'}:`, error);
    return null;
  }
}

async function sendToTelegram(token, multiplier = null, replyToMessageId = null) {
  const socialLinksText = token.socialLinks.length
    ? token.socialLinks.map(link => `<a href="${link}">🔗 ${new URL(link).hostname}</a>`).join('\n')
    : 'None';

  const tradeLink = `https://mevx.io/solana/${token.address}?ref=aV2RYY3VcBKW`;
  const replyMarkup = { inline_keyboard: [[{ text: 'Trade', url: tradeLink }]] };

  let message = `🟢🟢 New Gem Tracking 🟢🟢\n\n- Address: <code>${token.address}</code>\n- Symbol: ${token.symbol}\n- Name: ${token.name}\n- Mcap: ${Number(token.mcap).toLocaleString()} USD\n- Social Links: ${socialLinksText}`;

  if (multiplier && multiplier >= 2) {
    message += `\n\n🏆🏆 x${multiplier} from call 🧿🧿🧿🧿🧿🧿`;
  }

  try {
    let sentMessage;
    if (token.imageUrl) {
      sentMessage = await bot.telegram.sendPhoto(TELEGRAM_CHAT_ID, token.imageUrl, {
        caption: message,
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
        reply_to_message_id: replyToMessageId || null,
      });
    } else {
      sentMessage = await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, message, {
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
        reply_to_message_id: replyToMessageId || null,
      });
    }
    console.log(`Successfully sent message to Telegram with message ID: ${sentMessage.message_id}`);
    return { initialMcap: token.mcap, telegramMessageId: sentMessage.message_id };
  } catch (error) {
    console.error('Error sending message to Telegram:', error);
    return null;
  }
}

async function checkAndPostMCAP(postedTokens) {
  console.log('Checking MCAP for all tokens...');
  for (const [address, { initialMcap, telegramMessageId, maxMultiplier }] of postedTokens) {
    const currentTokenData = await fetchDexData(address);
    if (!currentTokenData) {
      console.log(`No Dexscreener data found for token ${address}`);
      continue;
    }

    const currentMcap = currentTokenData.mcap;
    const multiplier = currentMcap > 0 && initialMcap > 0 ? Math.round(currentMcap / initialMcap) : 1;

    if (multiplier >= 2 && telegramMessageId) {
      if (multiplier > maxMultiplier) {
        console.log(`MCAP of ${address} increased ${multiplier}x (new max), posting update to Telegram`);
        const result = await sendToTelegram(currentTokenData, multiplier, telegramMessageId);
        if (result) {
          postedTokens.set(address, {
            ...result,
            maxMultiplier: multiplier,
          });
          await savePostedTokens(postedTokens);
        }
      } else {
        console.log(`MCAP of ${address} multiplier (${multiplier}x) is not greater than max (${maxMultiplier}x), skipping`);
      }
    } else {
      console.log(`MCAP of ${address} multiplier (${multiplier}x) is less than 2x or no message ID, skipping`);
    }
  }
}

async function main() {
  console.log('Execution started at:', new Date().toISOString());
  const postedTokens = await loadPostedTokens();

  const tokens = await fetchTokens();
  if (!tokens.length) {
    console.log('No new tokens found from Moralis');
  } else {
    console.log(`Found ${tokens.length} tokens to check: ${tokens.join(', ')}`);

    for (const address of tokens) {
      console.log(`Checking token: ${address}, Already posted: ${postedTokens.has(address)}`);
      if (postedTokens.has(address)) {
        console.log(`Token ${address} already posted, skipping`);
        continue;
      }

      const tokenData = await fetchDexData(address);
      if (!tokenData) {
        console.log(`No Dexscreener data found for token ${address}`);
        continue;
      }

      if (tokenData.mcap < MIN_MCAP || tokenData.mcap > MAX_MCAP || tokenData.socialLinks.length === 0) {
        console.log(`Token ${address} does not meet criteria (MCAP: ${tokenData.mcap}, Socials: ${tokenData.socialLinks.length})`);
        continue;
      }

      const result = await sendToTelegram(tokenData);
      if (result) {
        console.log(`Adding token ${address} to postedTokens with initial MCAP ${result.initialMcap} and message ID ${result.telegramMessageId}`);
        postedTokens.set(address, { ...result, maxMultiplier: 1 });
        await savePostedTokens(postedTokens);
        console.log(`Successfully posted token ${address} with initial MCAP ${result.initialMcap} and message ID ${result.telegramMessageId}`);
      } else {
        console.log(`Failed to post token ${address} to Telegram, not saving to Firestore`);
      }
      break;
    }
  }

  await checkAndPostMCAP(postedTokens);
  console.log('Execution completed at:', new Date().toISOString());
}

main().catch(error => {
  console.error('Error in main:', error);
  process.exit(1);
});