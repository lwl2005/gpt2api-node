import bcrypt from 'bcryptjs';
import db, { initDatabase } from '../config/database.js';
import dotenv from 'dotenv';
import {
  DEFAULT_ADMIN_PASSWORD,
  DEFAULT_ADMIN_USERNAME,
  generateStrongAdminPassword,
  validateAdminPassword,
  validateAdminUsername
} from '../config/adminSecurityPolicy.js';

dotenv.config();

// 初始化数据库
initDatabase();

// 创建初始管理员账户
function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function resolveInitialAdminUsername() {
  const configuredUsername = String(process.env.ADMIN_USERNAME || '').trim();
  const username = configuredUsername || DEFAULT_ADMIN_USERNAME;
  const fromDefault = !configuredUsername;
  const usernameCheck = validateAdminUsername(username);

  if (!usernameCheck.valid) {
    throw new Error(`ADMIN_USERNAME 不合法：${usernameCheck.message}`);
  }

  return {
    username: usernameCheck.normalized,
    fromDefault
  };
}

function resolveInitialAdminPassword(username) {
  const configuredPassword = String(process.env.ADMIN_PASSWORD || '').trim();

  if (configuredPassword) {
    const passwordCheck = validateAdminPassword(configuredPassword, username);
    if (passwordCheck.valid) {
      return { password: configuredPassword, generated: false, fromDefault: false };
    }
    console.warn(`⚠ ADMIN_PASSWORD 不符合要求（${passwordCheck.message}），将回退为固定默认密码`);
  }

  const defaultPasswordCheck = validateAdminPassword(DEFAULT_ADMIN_PASSWORD, username);
  if (!defaultPasswordCheck.valid) {
    if (isProduction()) {
      throw new Error(`固定默认密码不符合要求：${defaultPasswordCheck.message}`);
    }
    const generated = generateStrongAdminPassword(20);
    return { password: generated, generated: true, fromDefault: false };
  }

  return { password: DEFAULT_ADMIN_PASSWORD, generated: false, fromDefault: true };
}

try {
  const { username: defaultUsername, fromDefault: usernameFromDefault } = resolveInitialAdminUsername();
  // 检查是否已存在管理员
  const existingUser = db.prepare('SELECT * FROM users WHERE username = ?').get(defaultUsername);
  
  if (!existingUser) {
    const {
      password: initialPassword,
      generated,
      fromDefault: passwordFromDefault
    } = resolveInitialAdminPassword(defaultUsername);
    const hashedPassword = await bcrypt.hash(initialPassword, 10);
    
    db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(
      defaultUsername,
      hashedPassword
    );
    
    console.log('✓ 初始管理员账户已创建');
    console.log(`  用户名: ${defaultUsername}`);
    if (passwordFromDefault) {
      console.log(`  初始密码: ${initialPassword}`);
      console.log('  ⚠ 当前使用固定默认账号密码，请登录后立即修改');
    } else if (generated) {
      console.log(`  初始密码: ${initialPassword}`);
      console.log('  ⚠ 当前为开发环境自动生成密码，仅显示一次，请立即登录后修改');
    } else {
      console.log('  初始密码来源: ADMIN_PASSWORD 环境变量（安全考虑不在日志回显）');
    }

    if (usernameFromDefault) {
      console.log('  ⚠ 当前使用默认用户名 admin，建议尽快改为自定义管理员用户名');
    }
  } else {
    console.log('✓ 管理员账户已存在');
  }
  
  console.log('\n数据库初始化完成！');
  process.exit(0);
} catch (error) {
  console.error('❌ 初始化失败:', error);
  process.exit(1);
}
