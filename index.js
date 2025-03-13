import { Telegraf } from 'telegraf';
import fs from 'fs/promises';
import path from 'path';

const MIN_MCAP = 50000; // 50K USD
const TOKEN_RETENTION_DAYS = 7; // Lưu token trong 7 ngày

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MORALIS_API_KEY = process.env.MORALIS_API_KEY;

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const POSTED_TOKENS_FILE = path.resolve('posted_tokens.json');

async function loadPostedTokens() {
  try {
    const data = await fs.readFile(POSTED_TOKENS_FILE, 'utf-8');
    if (!data.trim()) {
      console.log('File posted_tokens.json is empty, initializing as empty array');
      await fs.writeFile(POSTED_TOKENS_FILE, JSON.stringify([]));
      return new Map();
    }

    const tokensWithTimestamps = JSON.parse(data);
    if (!Array.isArray(tokensWithTimestamps)) {
      console.log('File posted_tokens.json contains invalid data, resetting to empty array');
      await fs.writeFile(POSTED_TOKENS_FILE, JSON.stringify([]));
      return new Map();
    }

    console.log('Loaded tokens from file:', tokensWithTimestamps);

    const now = new Date();
    const cutoffDate = new Date(now.getTime() - TOKEN_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    const validTokens = tokensWithTimestamps.filter(token => {
      const tokenDate = new Date(token.timestamp);
      return tokenDate >= cutoffDate;
    });

    if (validTokens.length !== tokensWithTimestamps.length) {
      await fs.writeFile(POSTED_TOKENS_FILE, JSON.stringify(validTokens, null, 2));
      console.log(`Removed ${tokensWithTimestamps.length - validTokens.length} old tokens`);
    }

    console.log('Valid tokens after filtering:', validTokens);
    return new Map(validTokens.map(token => [token.address, { timestamp: token.timestamp, initialMcap: token.initialMcap || 0, telegramMessageId: token.telegramMessageId || null }]));
  } catch (error) {
    if (error.code === 'ENOENT') {
      await fs.writeFile(POSTED_TOKENS_FILE, JSON.stringify([]));
      console.log('Created new posted_tokens.json file');
      return new Map();
    } else if (error instanceof SyntaxError) {
      console.error('File posted_tokens.json contains invalid JSON, resetting to empty array:', error);
      await fs.writeFile(POSTED_TOKENS_FILE, JSON.stringify([]));
      return new Map();
    }
    console.error('Error loading posted tokens:', error);
    return new Map();
  }
}

async function savePostedTokens(postedTokensMap) {
  try {
    let tokensWithTimestamps = [];
    try {
      const data = await fs.readFile(POSTED_TOKENS_FILE, 'utf-8');
      if (!data.trim()) {
        console.log('File posted_tokens.json is empty, initializing as empty array');
        tokensWithTimestamps = [];
      } else {
        tokensWithTimestamps = JSON.parse(data);
        if (!Array.isArray(tokensWithTimestamps)) {
          console.log('File posted_tokens.json contains invalid data, resetting to empty array');
          tokensWithTimestamps = [];
        }
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log('File posted_tokens.json does not exist, creating new file');
        tokensWithTimestamps = [];
      } else if (error instanceof SyntaxError) {
        console.error('File posted_tokens.json contains invalid JSON, resetting to empty array:', error);
        tokensWithTimestamps = [];
      } else {
        throw error;
      }
    }

    const now = new Date().toISOString();
    const tokenMap = new Map(tokensWithTimestamps.map(token => [token.address, { timestamp: token.timestamp, initialMcap: token.initialMcap || 0, telegramMessageId: token.telegramMessageId || null }]));

    for (const [address, data] of postedTokensMap) {
      if (!tokenMap.has(address)) {
        tokenMap.set(address, { address, timestamp: now, initialMcap: data.initialMcap, telegramMessageId: data.telegramMessageId || null });
        console.log(`Added new token to save: ${address} at ${now} with initial MCAP ${data.initialMcap}`);
      }
    }

    const updatedTokens = Array.from(tokenMap.entries()).map(([address, { timestamp, initialMcap, telegramMessageId }]) => ({ address, timestamp, initialMcap, telegramMessageId }));
    await fs.writeFile(POSTED_TOKENS_FILE, JSON.stringify(updatedTokens, null, 2));
    console.log(`Saved ${updatedTokens.length} tokens to posted_tokens.json`);
  } catch (error) {
    console.error('Error saving posted tokens:', error);
  }
}

async function fetchTokens() {
  try {
    console.log('Fetching graduated tokens from Moralis API for Pump.fun...');
    const options = {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'X-API-Key': process.env.MORALIS_API_KEY
      }
    };

    const exchange = 'pumpfun';
    const response = await fetch(`https://solana-gateway.moralis.io/token/mainnet/exchange/${exchange}/graduated?limit=20`, options);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    if (!data?.result) {
      console.log('No data returned from Moralis API');
      return [];
    }

    const tokens = data.result.map(token => token.address);
    console.log('Moralis API response - Graduated tokens:', data.result);
    console.log(`Fetched ${tokens.length} unique tokens from Moralis`);
    return tokens;
  } catch (error) {
    console.error('Error fetching data from Moralis:', error);
    return [];
  }
}

async function fetchDexData(address) {
  try {
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
    console.error(`Error fetching Dexscreener data for ${address}:`, error);
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

  // Thêm thông tin MCAP tăng nếu có multiplier
  if (multiplier && multiplier >= 2) {
    message += `\n\n🏆 x${multiplier} from call 🐋🐋🐋🐋🐋`;
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
    return { initialMcap: token.mcap, telegramMessageId: sentMessage.message_id };
  } catch (error) {
    console.error('Error sending message to Telegram:', error);
    return null;
  }
}

async function checkAndPostMCAP(postedTokens) {
  console.log('Checking MCAP for all tokens...');
  for (const [address, { initialMcap, telegramMessageId }] of postedTokens) {
    const currentTokenData = await fetchDexData(address);
    if (!currentTokenData) {
      console.log(`No Dexscreener data found for token ${address}`);
      continue;
    }

    const currentMcap = currentTokenData.mcap;
    const multiplier = currentMcap > 0 && initialMcap > 0 ? Math.round(currentMcap / initialMcap) : 1;

    if (multiplier >= 2 && telegramMessageId) {
      console.log(`MCAP of ${address} increased ${multiplier}x, posting update to Telegram`);
      await sendToTelegram(currentTokenData, multiplier, telegramMessageId);
    } else {
      console.log(`MCAP of ${address} multiplier (${multiplier}x) is less than 2x or no message ID, skipping`);
    }
  }
}

async function main() {
  console.log('Execution started at:', new Date().toISOString());
  const postedTokens = await loadPostedTokens();

  // Bước 1: Kiểm tra và đăng token mới
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

      if (tokenData.mcap < MIN_MCAP || tokenData.socialLinks.length === 0) {
        console.log(`Token ${address} does not meet criteria (MCAP: ${tokenData.mcap}, Socials: ${tokenData.socialLinks.length})`);
        continue;
      }

      const result = await sendToTelegram(tokenData);
      if (result) {
        postedTokens.set(address, { ...result, telegramMessageId: result.telegramMessageId });
        await savePostedTokens(postedTokens);
        console.log(`Successfully posted token ${address} with initial MCAP ${result.initialMcap} and message ID ${result.telegramMessageId}`);
      } else {
        console.log(`Failed to post token ${address} to Telegram, not saving to posted_tokens.json`);
      }
      break; // Chỉ đăng 1 token mỗi lần chạy
    }
  }

  // Bước 2: Kiểm tra MCAP của các token đã đăng
  await checkAndPostMCAP(postedTokens);

  console.log('Execution completed at:', new Date().toISOString());
}

main().catch(error => {
  console.error('Error in main:', error);
  process.exit(1);
});