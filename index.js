import { Telegraf } from 'telegraf';
import fs from 'fs/promises';
import path from 'path';
import { TwitterApi } from 'twitter-api-v2';

const MIN_MCAP = 50000; // 70K USD
const TOKEN_RETENTION_DAYS = 7; // Lưu token trong 7 ngày
const CHECK_INTERVAL_MINUTES = 10; // Kiểm tra lại mỗi 30 phút

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MORALIS_API_KEY = process.env.MORALIS_API_KEY;
const TWITTER_BEARER_TOKEN = process.env.TWITTER_BEARER_TOKEN;

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const POSTED_TOKENS_FILE = path.resolve('posted_tokens.json');

const twitterClient = new TwitterApi(TWITTER_BEARER_TOKEN);

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
      return tokenDate >= cutoffDate; // Không lọc theo tweeted để giữ tất cả token
    });

    if (validTokens.length !== tokensWithTimestamps.length) {
      await fs.writeFile(POSTED_TOKENS_FILE, JSON.stringify(validTokens, null, 2));
      console.log(`Removed ${tokensWithTimestamps.length - validTokens.length} old tokens`);
    }

    const tokenMap = new Map(validTokens.map(token => [token.address, { timestamp: token.timestamp, initialMcap: token.initialMcap || 0, tweeted: token.tweeted || false, telegramMessageId: token.telegramMessageId || null }]));
    console.log('Valid tokens after filtering:', Array.from(tokenMap.entries()));
    return tokenMap;
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
    const tokenMap = new Map(tokensWithTimestamps.map(token => [token.address, { timestamp: token.timestamp, initialMcap: token.initialMcap || 0, tweeted: token.tweeted || false, telegramMessageId: token.telegramMessageId || null }]));

    for (const [address, data] of postedTokensMap) {
      if (!tokenMap.has(address)) {
        tokenMap.set(address, { address, timestamp: now, initialMcap: data.initialMcap, tweeted: data.tweeted || false, telegramMessageId: data.telegramMessageId || null });
        console.log(`Added new token to save: ${address} at ${now} with initial MCAP ${data.initialMcap}`);
      }
    }

    const updatedTokens = Array.from(tokenMap.entries()).map(([address, { timestamp, initialMcap, tweeted, telegramMessageId }]) => ({ address, timestamp, initialMcap, tweeted, telegramMessageId }));
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
    const response = await fetch(`https://solana-gateway.moralis.io/token/mainnet/exchange/${exchange}/graduated`, options);

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
    let sentMessage;
    if (token.imageUrl) {
      sentMessage = await bot.telegram.sendPhoto(TELEGRAM_CHAT_ID, token.imageUrl, {
        caption: message,
        parse_mode: 'HTML',
        reply_markup: replyMarkup
      });
    } else {
      sentMessage = await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, message, {
        parse_mode: 'HTML',
        reply_markup: replyMarkup
      });
    }
    return { initialMcap: token.mcap, telegramMessageId: sentMessage.message_id }; // Trả về MCAP và message_id
  } catch (error) {
    console.error('Error sending message to Telegram:', error);
    return null;
  }
}

async function sendToTwitter(tokenAddress, initialMcap, telegramMessageId) {
  try {
    const currentTokenData = await fetchDexData(tokenAddress);
    if (!currentTokenData) {
      console.error('Failed to fetch current token data for Twitter post');
      return;
    }

    const currentMcap = currentTokenData.mcap;
    const multiplier = currentMcap > 0 && initialMcap > 0 ? Math.round(currentMcap / initialMcap) : 1;

    if (multiplier < 2) {
      console.log(`Skipping Twitter post for ${tokenAddress}: MCAP multiplier (${multiplier}x) is less than 2x`);
      return;
    }

    // Định dạng MCAP thành dạng ngắn gọn (50k, 150k)
    const formatMcap = (mcap) => {
      if (mcap >= 1_000_000) return `${Math.round(mcap / 1_000_000)}M`;
      if (mcap >= 1_000) return `${Math.round(mcap / 1_000)}k`;
      return mcap.toLocaleString();
    };

    // Tạo link đến bài đăng Telegram
    const telegramPostUrl = `https://t.me/radiosignal_sniper/${telegramMessageId}`;
    const caption = `🏆 x${multiplier} from call 🐋🐋🐋\nMCAP: ${formatMcap(initialMcap)} 🌙🌙🌙 ${formatMcap(currentMcap)}`;
    const tweetContent = `${caption}\n${telegramPostUrl}`;

    await twitterClient.v2.tweet(tweetContent);

    console.log(`Successfully posted to Twitter for ${tokenAddress} with caption: ${tweetContent}`);

    // Đánh dấu token đã tweet
    const postedTokens = await loadPostedTokens();
    if (postedTokens.has(tokenAddress)) {
      postedTokens.set(tokenAddress, { ...postedTokens.get(tokenAddress), tweeted: true });
      await savePostedTokens(postedTokens);
    }
  } catch (error) {
    console.error('Error sending tweet to Twitter:', error);
  }
}

async function checkAndPostToTwitter() {
  console.log('Checking and posting to Twitter for all tokens...');
  const postedTokens = await loadPostedTokens();

  // Tạo danh sách token thỏa mãn điều kiện
  const eligibleTokens = [];
  for (const [address, { initialMcap, tweeted, telegramMessageId }] of postedTokens) {
    const currentTokenData = await fetchDexData(address);
    if (currentTokenData) {
      const currentMcap = currentTokenData.mcap;
      const multiplier = currentMcap > 0 && initialMcap > 0 ? currentMcap / initialMcap : 1;
      if (multiplier >= 2 && telegramMessageId) {
        eligibleTokens.push({ address, currentMcap, initialMcap, tweeted, telegramMessageId });
      }
    }
  }

  // Lọc và sắp xếp token
  if (eligibleTokens.length > 0) {
    // Ưu tiên token chưa tweet và có MCAP hiện tại cao nhất
    const untweetedTokens = eligibleTokens.filter(token => !token.tweeted);
    const tweetedTokens = eligibleTokens.filter(token => token.tweeted);

    let bestToken = null;
    if (untweetedTokens.length > 0) {
      // Chọn token chưa tweet có MCAP cao nhất
      untweetedTokens.sort((a, b) => b.currentMcap - a.currentMcap);
      bestToken = untweetedTokens[0];
    } else if (tweetedTokens.length > 0) {
      // Nếu không có token chưa tweet, chọn token đã tweet nhưng có MCAP cao nhất
      tweetedTokens.sort((a, b) => b.currentMcap - a.currentMcap);
      bestToken = tweetedTokens[0];
    }

    if (bestToken) {
      await sendToTwitter(bestToken.address, bestToken.initialMcap, bestToken.telegramMessageId);
    }
  } else {
    console.log('No tokens eligible for Twitter post (no significant MCAP change >= 2x)');
  }
}

async function main() {
  console.log('Execution started at:', new Date().toISOString());
  const postedTokens = await loadPostedTokens();

  const tokens = await fetchTokens();
  if (!tokens.length) {
    console.log('No new tokens found from Moralis');
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

    const result = await sendToTelegram(tokenData);
    if (result) {
      postedTokens.set(address, { ...result });
      await savePostedTokens(postedTokens);
      console.log(`Successfully posted token ${address} to Telegram with initial MCAP ${result.initialMcap} and message ID ${result.telegramMessageId}`);
    }
    break; // Chỉ đăng 1 token mỗi lần chạy
  }
}

main().catch(error => {
  console.error('Error in main:', error);
  process.exit(1);
});

// Chạy checkAndPostToTwitter định kỳ
setInterval(checkAndPostToTwitter, CHECK_INTERVAL_MINUTES * 60 * 1000);