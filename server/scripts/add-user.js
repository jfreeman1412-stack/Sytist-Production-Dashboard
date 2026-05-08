// CLI helper for adding users.
//
// Usage:
//   node scripts/add-user.js <username> <password> [displayName] [role]
//
// Examples:
//   node scripts/add-user.js joey hunter2
//   node scripts/add-user.js joey hunter2 "Joey Freeman" admin
//   node scripts/add-user.js viewer1 password123 "View Only" viewer

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const databaseService = require('../services/database');
const authService = require('../services/authService');

async function main() {
  const [, , username, password, displayName, role = 'admin'] = process.argv;

  if (!username || !password) {
    console.error('Usage: node scripts/add-user.js <username> <password> [displayName] [role]');
    console.error('       role defaults to "admin" — must be admin, operator, or viewer');
    process.exit(1);
  }

  databaseService.init();

  try {
    const user = await authService.createUser(username, password, displayName, role);
    console.log('✅ User created:');
    console.log(JSON.stringify(user, null, 2));
  } catch (err) {
    console.error('❌ Failed to create user:', err.message);
    process.exit(1);
  } finally {
    databaseService.close();
  }
}

main();
