const { promisify } = require("node:util");
const { createHash, randomBytes, scrypt: scryptCallback, timingSafeEqual } = require("node:crypto");
const { Pool } = require("pg");

const scrypt = promisify(scryptCallback);
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const USERNAME_PATTERN = /^[a-z0-9_.-]{3,32}$/;
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 1024;

function createError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeUsername(username) {
  if (typeof username !== "string") {
    throw createError(400, "Username must be text.");
  }
  const normalized = username.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(normalized)) {
    throw createError(400, "Use 3-32 letters, numbers, dots, underscores, or hyphens for usernames.");
  }
  return normalized;
}

function validatePassword(password) {
  if (
    typeof password !== "string" ||
    password.length < PASSWORD_MIN_LENGTH ||
    password.length > PASSWORD_MAX_LENGTH
  ) {
    throw createError(400, `Passwords must be between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters.`);
  }
  return password;
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

async function verifyPassword(password, encodedHash) {
  const [algorithm, saltHex, hashHex] = encodedHash.split("$");
  if (algorithm !== "scrypt" || !/^[a-f0-9]{32}$/i.test(saltHex) || !/^[a-f0-9]{128}$/i.test(hashHex)) {
    throw new Error("Stored password hash has an invalid format.");
  }
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

function sessionDigest(token) {
  return createHash("sha256").update(token).digest();
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    isAdmin: row.is_admin,
    createdAt: row.created_at,
  };
}

function createDatabase(config) {
  const requiredSettings = ["host", "database", "user", "password"];
  const missingSetting = requiredSettings.find((setting) => !config[setting]);
  if (missingSetting) {
    throw new Error(`PostgreSQL ${missingSetting} is required.`);
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error("POSTGRES_PORT must be a valid TCP port.");
  }
  const pool = new Pool({ ...config, max: 10 });
  pool.on("error", (error) => {
    console.error("Unexpected PostgreSQL client error:", error);
  });

  async function initialize(adminUsername, adminPassword) {
    const username = normalizeUsername(adminUsername);
    validatePassword(adminPassword);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_users (
        id BIGSERIAL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        is_admin BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS app_sessions (
        token_hash BYTEA PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS app_sessions_expires_at_idx ON app_sessions (expires_at);
      CREATE TABLE IF NOT EXISTS conversations (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS conversations_user_updated_idx
        ON conversations (user_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS messages (
        id BIGSERIAL PRIMARY KEY,
        conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        stats JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS stats JSONB;
      CREATE INDEX IF NOT EXISTS messages_conversation_id_idx ON messages (conversation_id, id);
    `);

    const passwordHash = await hashPassword(adminPassword);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO app_users (username, password_hash, is_admin)
         VALUES ($1, $2, TRUE)
         ON CONFLICT (username) DO NOTHING`,
        [username, passwordHash],
      );
      const result = await client.query("SELECT is_admin FROM app_users WHERE username = $1", [username]);
      if (!result.rows[0]?.is_admin) {
        throw new Error(`ADMIN_USERNAME "${username}" is already assigned to a non-admin user.`);
      }
      await client.query("DELETE FROM app_sessions WHERE expires_at <= NOW()");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function authenticate(username, password) {
    const normalized = normalizeUsername(username);
    if (typeof password !== "string" || password.length > PASSWORD_MAX_LENGTH) {
      throw createError(401, "Invalid username or password.");
    }
    const result = await pool.query(
      "SELECT id, username, password_hash, is_admin, created_at FROM app_users WHERE username = $1",
      [normalized],
    );
    const user = result.rows[0];
    const dummyHash = "scrypt$00000000000000000000000000000000$00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
    const matches = await verifyPassword(password, user?.password_hash || dummyHash);
    if (!user || !matches) {
      throw createError(401, "Invalid username or password.");
    }
    return publicUser(user);
  }

  async function createSession(userId) {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
    await pool.query(
      "INSERT INTO app_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)",
      [sessionDigest(token), userId, expiresAt],
    );
    return { token, expiresAt };
  }

  async function getSession(token) {
    if (!token || !/^[A-Za-z0-9_-]{40,50}$/.test(token)) return null;
    const result = await pool.query(
      `SELECT u.id, u.username, u.is_admin, u.created_at
       FROM app_sessions s
       JOIN app_users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
      [sessionDigest(token)],
    );
    return result.rows[0] ? publicUser(result.rows[0]) : null;
  }

  async function deleteSession(token) {
    if (!token || !/^[A-Za-z0-9_-]{40,50}$/.test(token)) return;
    await pool.query("DELETE FROM app_sessions WHERE token_hash = $1", [sessionDigest(token)]);
  }

  async function listUsers() {
    const result = await pool.query(
      "SELECT id, username, is_admin, created_at FROM app_users ORDER BY created_at, id",
    );
    return result.rows.map(publicUser);
  }

  async function createUser(username, password) {
    const normalized = normalizeUsername(username);
    const validatedPassword = validatePassword(password);
    const passwordHash = await hashPassword(validatedPassword);
    try {
      const result = await pool.query(
        `INSERT INTO app_users (username, password_hash)
         VALUES ($1, $2)
         RETURNING id, username, is_admin, created_at`,
        [normalized, passwordHash],
      );
      return publicUser(result.rows[0]);
    } catch (error) {
      if (error.code === "23505") {
        throw createError(409, "That username is already taken.");
      }
      throw error;
    }
  }

  async function listConversations(userId) {
    const result = await pool.query(
      `SELECT id, title, model, created_at, updated_at
       FROM conversations WHERE user_id = $1
       ORDER BY updated_at DESC, id DESC`,
      [userId],
    );
    return result.rows;
  }

  async function getConversation(userId, conversationId) {
    const result = await pool.query(
      `SELECT id, title, model, created_at, updated_at
       FROM conversations WHERE user_id = $1 AND id = $2`,
      [userId, conversationId],
    );
    if (!result.rows[0]) throw createError(404, "Conversation not found.");
    const messages = await pool.query(
      "SELECT role, content, stats, created_at FROM messages WHERE conversation_id = $1 ORDER BY id",
      [conversationId],
    );
    return { ...result.rows[0], messages: messages.rows };
  }

  async function startUserTurn(userId, conversationId, model, content) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      let conversation;
      if (conversationId === null) {
        const title = content.trim().replace(/\s+/g, " ").slice(0, 100) || "New chat";
        const created = await client.query(
          `INSERT INTO conversations (user_id, title, model)
           VALUES ($1, $2, $3)
           RETURNING id`,
          [userId, title, model],
        );
        conversation = created.rows[0];
      } else {
        const existing = await client.query(
          "SELECT id FROM conversations WHERE id = $1 AND user_id = $2 FOR UPDATE",
          [conversationId, userId],
        );
        if (!existing.rows[0]) throw createError(404, "Conversation not found.");
        conversation = existing.rows[0];
      }
      await client.query(
        "INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', $2)",
        [conversation.id, content],
      );
      await client.query(
        "UPDATE conversations SET model = $1, updated_at = NOW() WHERE id = $2",
        [model, conversation.id],
      );
      const history = await client.query(
        "SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY id",
        [conversation.id],
      );
      await client.query("COMMIT");
      return { id: conversation.id, messages: history.rows };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function saveAssistantMessage(userId, conversationId, content, stats) {
    await pool.query(
      `INSERT INTO messages (conversation_id, role, content, stats)
       SELECT id, 'assistant', $3, $4::jsonb FROM conversations
       WHERE id = $1 AND user_id = $2`,
      [conversationId, userId, content, JSON.stringify(stats)],
    );
    await pool.query(
      "UPDATE conversations SET updated_at = NOW() WHERE id = $1 AND user_id = $2",
      [conversationId, userId],
    );
  }

  return {
    pool,
    initialize,
    authenticate,
    createSession,
    getSession,
    deleteSession,
    listUsers,
    createUser,
    listConversations,
    getConversation,
    startUserTurn,
    saveAssistantMessage,
  };
}

module.exports = { createDatabase, normalizeUsername, validatePassword, createError };
