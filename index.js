import { Telegraf } from 'telegraf';
import fs from 'fs/promises';
import path from 'path';

const DUNE_API_URL = 'https://api.dune.com/api/v1/query/4833321/results?limit=10&refresh=true';
const MIN_MCAP = 70000; // 70K USD
const TOKEN_RETENTION_DAYS = 7; // Lưu token trong 7 ngày

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const DUNE_API_KEY = process.env.DUNE_API_KEY;

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const POSTED_TOKENS_FILE = path.resolve('posted_tokens.json');

async function loadPostedTokens() {
  try {
    const data = await fs.readFile(POSTED_TOKENS_FILE, 'utf-8');
    const tokensWithTimestamps = JSON.parse(data);
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
    return new Set(validTokens.map(token => token.address));
  } catch (error) {
    if (error.code === 'ENOENT') {
      await fs.writeFile(POSTED_TOKENS_FILE, JSON.stringify([]));
      console.log('Created new posted_tokens.json file');
      return new Set();
    }
    console.error('Error loading posted tokens:', error);
    return new Set();
  }
}

async function savePostedTokens(postedTokensSet) {
  try {
    let tokensWithTimestamps = [];
    try {
      const data = await fs.readFile(POSTED_TOKENS_FILE, 'utf-8');
      tokensWithTimestamps = JSON.parse(data);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const now = new Date().toISOString();
    const tokenMap = new Map(tokensWithTimestamps.map(token => [token.address, token]));

    for (const address of postedTokensSet) {
      if (!tokenMap.has(address)) {
        tokenMap.set(address, { address, timestamp: now });
        console.log(`Added new token to save: ${address} at ${now}`);
      }
    }

    const updatedTokens = Array.from(tokenMap.values());
    await fs.writeFile(POSTED_TOKENS_FILE, JSON.stringify(updatedTokens, null, 2));
    console.log(`Saved ${updatedTokens.length} tokens to posted_tokens.json`);
  } catch (error) {
    console.error('Error saving posted tokens:', error);
  }
}

async function fetchTokens() {
  try {
    console.log('Fetching tokens from Dune API...');
    const response = await fetch(DUNE_API_URL, {
      method: 'GET',
      headers: { 'X-Dune-API-Key': DUNE_API_KEY }
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    if (!data?.result?.rows) {
      console.log('No data returned from Dune API');
      return [];
    }

    console.log('Dune API response:', JSON.stringify(data.result.rows, null, 2));
    console.log(`Fetched ${data.result.rows.length} tokens from Dune`);
    return data.result.rows.map(row => row.token_address);
  } catch (error) {
    console.error('Error fetching data from Dune:', error);
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

async function sendToTelegram(token) {
  const socialLinksText = token.socialLinks.length
    ? token.socialLinks.map(link => `<a href="${link}">🔗 ${new URL(link).hostname}</a>`).join('\n')
    : 'None';

  const tradeLink = `https://mevx.io/solana/${token.address}?ref=aV2RYY3VcBKW`;
  const replyMarkup = { inline_keyboard: [[{ text: 'Trade', url: tradeLink }]] };

  const message = `🟢🟢 New Gem Tracking 🟢🟢

- Address: <code>${token.address}</code>
- Symbol: ${token.symbol}
- Name: ${token.name}
- Mcap: ${Number(token.mcap).toLocaleString()} USD
- Social Links: ${socialLinksText}`;

  try {
    if (token.imageUrl) {
      await bot.telegram.sendPhoto(TELEGRAM_CHAT_ID, token.imageUrl, {
        caption: message,
        parse_mode: 'HTML',
        reply_markup: replyMarkup
      });
    } else {
      await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, message, {
        parse_mode: 'HTML',
        reply_markup: replyMarkup
      });
    }
  } catch (error) {
    console.error('Error sending message to Telegram:', error);
  }
}

async function main() {
  console.log('Execution started at:', new Date().toISOString());
  const postedTokens = await loadPostedTokens();

  const tokens = await fetchTokens();
  if (!tokens.length) {
    console.log('No new tokens found from Dune');
    return;
  }

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

    await sendToTelegram(tokenData);
    postedTokens.add(address);
    await savePostedTokens(postedTokens);
    console.log(`Successfully posted token ${address}`);
    break;
  }
}

main().catch(error => {
  console.error('Error in main:', error);
  process.exit(1);
});