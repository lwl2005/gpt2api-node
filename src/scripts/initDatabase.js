import bcrypt from 'bcryptjs';
import db, { initDatabase } from '../config/database.js';
import dotenv from 'dotenv';
import { randomBytes } from 'crypto';

dotenv.config();

// 初始化数据库
initDatabase();

// 创建初始管理员账户
const defaultUsername = process.env.ADMIN_USERNAME || 'admin';

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function resolveInitialAdminPassword() {
  const configuredPassword = String(process.env.ADMIN_PASSWORD || '').trim();
  if (configuredPassword.length >= 8) {
    return { password: configuredPassword, generated: false };
  }

  if (isProduction()) {
    throw new Error('生产环境必须设置强密码 ADMIN_PASSWORD（至少 8 位）');
  }

  const generated = randomBytes(18).toString('hex');
  return { password: generated, generated: true };
}

try {
  // 检查是否已存在管理员
  const existingUser = db.prepare('SELECT * FROM users WHERE username = ?').get(defaultUsername);
  
  if (!existingUser) {
    const { password: initialPassword, generated } = resolveInitialAdminPassword();
    const hashedPassword = await bcrypt.hash(initialPassword, 10);
    
    db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(
      defaultUsername,
      hashedPassword
    );
    
    console.log('✓ 初始管理员账户已创建');
    console.log(`  用户名: ${defaultUsername}`);
    if (generated) {
      console.log(`  初始密码: ${initialPassword}`);
      console.log('  ⚠ 当前为开发环境自动生成密码，仅显示一次，请立即登录后修改');
    } else {
      console.log('  初始密码来源: ADMIN_PASSWORD 环境变量（安全考虑不在日志回显）');
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
