const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

let db;

function initDatabase() {
  // Create data directory if it doesn't exist
  const dataDir = path.join(__dirname, '../data');
  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
      console.log('✅ Created data directory:', dataDir);
    }
  } catch (err) {
    console.error('❌ Failed to create data directory:', err);
    throw err;
  }

  const dbPath = path.join(dataDir, 'cineby.db');
  console.log('🗄️ Opening database at:', dbPath);

  db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
      console.error('❌ Error opening database:', err);
      throw err;
    } else {
      console.log('✅ Connected to SQLite database at:', dbPath);
      createTables();
    }
  });
}

function createTables() {
  // Use serialize to ensure tables are created in order
  db.serialize(() => {
    // Users table - create with all columns including password and is_admin
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      avatar TEXT,
      theme TEXT DEFAULT 'default',
      password TEXT,
      is_admin INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_active DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
      if (err) {
        console.error('Error creating users table:', err);
      }
    });

    // User progress table
    db.run(`CREATE TABLE IF NOT EXISTS user_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      content_id TEXT NOT NULL,
      content_type TEXT NOT NULL,
      season_number INTEGER DEFAULT NULL,
      episode_number INTEGER DEFAULT NULL,
      progress_time INTEGER DEFAULT 0,
      total_time INTEGER DEFAULT 0,
      completed BOOLEAN DEFAULT 0,
      last_watched DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id),
      UNIQUE(user_id, content_id, season_number, episode_number)
    )`);

    // User favorites table
    db.run(`CREATE TABLE IF NOT EXISTS user_favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      content_id TEXT NOT NULL,
      content_type TEXT NOT NULL,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id),
      UNIQUE(user_id, content_id)
    )`);

    // Playlists table - create with show_on_home column
    db.run(`CREATE TABLE IF NOT EXISTS user_playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      name TEXT NOT NULL,
      description TEXT,
      show_on_home INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id)
    )`);

    // Playlist items table
    db.run(`CREATE TABLE IF NOT EXISTS playlist_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id INTEGER,
      content_id TEXT NOT NULL,
      content_type TEXT NOT NULL,
      position INTEGER NOT NULL,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (playlist_id) REFERENCES user_playlists (id) ON DELETE CASCADE,
      UNIQUE(playlist_id, content_id)
    )`);

    // Intro detection tables
    db.run(`CREATE TABLE IF NOT EXISTS intro_detection_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_id TEXT NOT NULL,
      season_number INTEGER,
      episode_number INTEGER,
      intro_start INTEGER NOT NULL,
      intro_end INTEGER NOT NULL,
      source TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      api_response TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME,
      UNIQUE(content_id, season_number, episode_number)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS user_intro_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      content_id TEXT NOT NULL,
      season_number INTEGER,
      episode_number INTEGER,
      intro_start INTEGER NOT NULL,
      intro_end INTEGER NOT NULL,
      submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      votes_up INTEGER DEFAULT 0,
      votes_down INTEGER DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users (id),
      UNIQUE(user_id, content_id, season_number, episode_number)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS intro_submission_votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      submission_id INTEGER,
      vote_type TEXT NOT NULL,
      voted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id),
      FOREIGN KEY (submission_id) REFERENCES user_intro_submissions (id) ON DELETE CASCADE,
      UNIQUE(user_id, submission_id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS intro_presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_id TEXT NOT NULL,
      season_number INTEGER,
      intro_start INTEGER NOT NULL,
      intro_end INTEGER NOT NULL,
      confidence REAL DEFAULT 0.5,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(content_id, season_number)
    )`);

    // User genre preferences table
    db.run(`CREATE TABLE IF NOT EXISTS user_genre_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      content_type TEXT NOT NULL,
      genre_ids TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id),
      UNIQUE(user_id, content_type)
    )`);

    // Migrate: add ending columns to intro cache if they don't exist yet
    db.run(`ALTER TABLE intro_detection_cache ADD COLUMN ending_start INTEGER`, () => {});
    db.run(`ALTER TABLE intro_detection_cache ADD COLUMN ending_end INTEGER`, () => {});

    // Create default Admin account after all tables are created
    db.run(`SELECT 1`, () => {
      ensureDefaultAdmin().catch(err => {
        console.error('Error ensuring default Admin account:', err);
      });
    });
  });
}

// User functions
async function createUser(name, avatar = null, theme = 'default', password = null) {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare('INSERT INTO users (name, avatar, theme, password) VALUES (?, ?, ?, ?)');
    stmt.run([name, avatar, theme, password], async function(err) {
      if (err) {
        reject(err);
      } else {
        const userId = this.lastID;

        // Create default playlists after user is created
        try {
          await createDefaultPlaylistsForUser(userId);
          resolve(userId);
        } catch (error) {
          console.error('Error creating default playlists:', error);
          // Still resolve with userId even if playlist creation fails
          resolve(userId);
        }
      }
    });
    stmt.finalize();
  });
}

async function ensureDefaultAdmin() {
  return new Promise(async (resolve, reject) => {
    try {
      // Check if Admin user already exists
      db.get('SELECT id FROM users WHERE name = ?', ['Admin'], async (err, row) => {
        if (err) {
          reject(err);
        } else if (!row) {
          // Admin doesn't exist, create it with password
          console.log('Creating default Admin account...');
          const stmt = db.prepare('INSERT INTO users (name, avatar, theme, password, is_admin) VALUES (?, ?, ?, ?, ?)');
          stmt.run(['Admin', 'avatar1.png', 'default', 'icyriver', 1], async function(err) {
            if (err) {
              console.error('Error creating Admin account:', err);
              reject(err);
            } else {
              const userId = this.lastID;
              try {
                await createDefaultPlaylistsForUser(userId);
                console.log('Default Admin account created with password');
                resolve();
              } catch (playlistErr) {
                console.error('Error creating default playlists for Admin:', playlistErr);
                resolve(); // Still resolve even if playlists fail
              }
            }
          });
          stmt.finalize();
        } else {
          // Admin already exists, ensure it has password and is_admin flag
          db.run('UPDATE users SET password = ?, is_admin = 1 WHERE name = ? AND (password IS NULL OR is_admin = 0)',
            ['icyriver', 'Admin'],
            (err) => {
              if (err) {
                console.error('Error updating Admin account:', err);
              }
              resolve();
            }
          );
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function createDefaultPlaylistsForUser(userId) {
  const defaultPlaylists = [
    { name: 'Favorites', description: 'Your favorite movies and TV shows' },
    { name: 'Save for Later', description: 'Content to watch later' }
  ];

  for (const playlist of defaultPlaylists) {
    try {
      await createPlaylist(userId, playlist.name, playlist.description);
    } catch (error) {
      console.error(`Error creating playlist ${playlist.name}:`, error);
    }
  }
}

function getUsers() {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM users ORDER BY last_active DESC', (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function getUserById(userId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM users WHERE id = ?', [userId], (err, row) => {
      if (err) reject(err);
      else resolve(row || null);
    });
  });
}

function updateUser(userId, { name, avatar, theme } = {}) {
  return new Promise((resolve, reject) => {
    const fields = [];
    const params = [];
    if (name   !== undefined) { fields.push('name = ?');   params.push(name); }
    if (avatar !== undefined) { fields.push('avatar = ?'); params.push(avatar); }
    if (theme  !== undefined) { fields.push('theme = ?');  params.push(theme); }
    if (!fields.length) return resolve();
    params.push(userId);
    db.run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, params, function(err) {
      if (err) reject(err);
      else resolve();
    });
  });
}

function getContinueWatching(userId, limit = 20) {
  return new Promise((resolve, reject) => {
    db.all(`
      SELECT * FROM user_progress
      WHERE user_id = ? AND completed = 0 AND progress_time > 0
      ORDER BY last_watched DESC
      LIMIT ?
    `, [userId, limit], (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function deleteUser(userId) {
  return new Promise((resolve, reject) => {
    // Check if user is Admin - Admin cannot be deleted
    db.get('SELECT is_admin, name FROM users WHERE id = ?', [userId], (err, user) => {
      if (err) {
        reject(err);
      } else if (!user) {
        reject(new Error('User not found'));
      } else if (user.is_admin === 1 || user.name === 'Admin') {
        reject(new Error('Cannot delete Admin account'));
      } else {
        // Delete user and all related data
        const stmt = db.prepare('DELETE FROM users WHERE id = ?');
        stmt.run([userId], function(err) {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
        stmt.finalize();
      }
    });
  });
}

function updateUserLastActive(userId) {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare('UPDATE users SET last_active = CURRENT_TIMESTAMP WHERE id = ?');
    stmt.run([userId], function(err) {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
    stmt.finalize();
  });
}

function updateUserTheme(userId, theme) {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare('UPDATE users SET theme = ? WHERE id = ?');
    stmt.run([theme, userId], function(err) {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
    stmt.finalize();
  });
}

function updateUserAvatar(userId, avatar) {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare('UPDATE users SET avatar = ? WHERE id = ?');
    stmt.run([avatar, userId], function(err) {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
    stmt.finalize();
  });
}

function updateUserIsAdmin(userId, isAdmin) {
  return new Promise((resolve, reject) => {
    // Prevent demoting or changing the built-in Admin account by name
    db.get('SELECT name FROM users WHERE id = ?', [userId], (err, row) => {
      if (err) return reject(err);
      if (!row) return reject(new Error('User not found'));
      if (row.name === 'Admin') return reject(new Error('Cannot change built-in Admin account'));

      const stmt = db.prepare('UPDATE users SET is_admin = ? WHERE id = ?');
      stmt.run([isAdmin ? 1 : 0, userId], function(runErr) {
        if (runErr) {
          reject(runErr);
        } else {
          resolve();
        }
      });
      stmt.finalize();
    });
  });
}

// Progress functions
function updateUserProgress(userId, contentId, progressTime, contentType, totalTime = null, seasonNumber = null, episodeNumber = null) {
  return new Promise((resolve, reject) => {
    const completed = totalTime && progressTime >= totalTime * 0.9 ? 1 : 0;

    // Build where clause based on content type
    let whereClause = 'WHERE user_id = ? AND content_id = ?';
    let whereParams = [userId, contentId];

    if (contentType === 'tv' && seasonNumber !== null && episodeNumber !== null) {
      whereClause += ' AND season_number = ? AND episode_number = ?';
      whereParams.push(seasonNumber, episodeNumber);
    } else {
      whereClause += ' AND season_number IS NULL AND episode_number IS NULL';
    }

    // First get existing total_time if any
    db.get(`SELECT total_time FROM user_progress ${whereClause}`, whereParams, (err, row) => {
      if (err) {
        reject(err);
        return;
      }

      const finalTotalTime = totalTime || (row ? row.total_time : 0);

      const stmt = db.prepare(`
        INSERT OR REPLACE INTO user_progress
        (user_id, content_id, content_type, season_number, episode_number, progress_time, total_time, completed, last_watched)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `);

      stmt.run([userId, contentId, contentType, seasonNumber, episodeNumber, progressTime, finalTotalTime, completed], function(err) {
        if (err) {
          reject(err);
        } else {
          updateUserLastActive(userId);
          resolve();
        }
      });
      stmt.finalize();
    });
  });
}

function getUserProgress(userId, contentId = null, seasonNumber = null, episodeNumber = null) {
  return new Promise((resolve, reject) => {
    let query, params;

    if (contentId) {
      if (seasonNumber !== null && episodeNumber !== null) {
        // Get specific episode progress
        query = 'SELECT * FROM user_progress WHERE user_id = ? AND content_id = ? AND season_number = ? AND episode_number = ?';
        params = [userId, contentId, seasonNumber, episodeNumber];
      } else {
        // Get all progress for this content (movie or all episodes of a show)
        query = 'SELECT * FROM user_progress WHERE user_id = ? AND content_id = ? ORDER BY season_number, episode_number';
        params = [userId, contentId];
      }
    } else {
      query = 'SELECT * FROM user_progress WHERE user_id = ? ORDER BY last_watched DESC';
      params = [userId];
    }

    const method = (contentId && seasonNumber !== null && episodeNumber !== null) ? 'get' : 'all';
    db[method](query, params, (err, result) => {
      if (err) {
        reject(err);
      } else {
        resolve(result);
      }
    });
  });
}

// Favorites functions
function addToFavorites(userId, contentId, contentType) {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare('INSERT OR IGNORE INTO user_favorites (user_id, content_id, content_type) VALUES (?, ?, ?)');
    stmt.run([userId, contentId, contentType], function(err) {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
    stmt.finalize();
  });
}

function removeFromFavorites(userId, contentId) {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare('DELETE FROM user_favorites WHERE user_id = ? AND content_id = ?');
    stmt.run([userId, contentId], function(err) {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
    stmt.finalize();
  });
}

function getUserFavorites(userId) {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM user_favorites WHERE user_id = ? ORDER BY added_at DESC', [userId], (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

// Playlist functions
function createPlaylist(userId, name, description = null, showOnHome = 0) {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare('INSERT INTO user_playlists (user_id, name, description, show_on_home) VALUES (?, ?, ?, ?)');
    stmt.run([userId, name, description, showOnHome], function(err) {
      if (err) {
        reject(err);
      } else {
        resolve(this.lastID);
      }
    });
    stmt.finalize();
  });
}

function getUserPlaylists(userId) {
  return new Promise((resolve, reject) => {
    db.all(`
      SELECT p.*, COUNT(pi.id) as item_count
      FROM user_playlists p
      LEFT JOIN playlist_items pi ON p.id = pi.playlist_id
      WHERE p.user_id = ?
      GROUP BY p.id
      ORDER BY p.updated_at DESC
    `, [userId], (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

function updatePlaylist(playlistId, name, description = null) {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare('UPDATE user_playlists SET name = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    stmt.run([name, description, playlistId], function(err) {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
    stmt.finalize();
  });
}

function togglePlaylistHomeDisplay(playlistId) {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare('UPDATE user_playlists SET show_on_home = 1 - show_on_home, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    stmt.run([playlistId], function(err) {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
    stmt.finalize();
  });
}

function deletePlaylist(playlistId) {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare('DELETE FROM user_playlists WHERE id = ?');
    stmt.run([playlistId], function(err) {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
    stmt.finalize();
  });
}

function addToPlaylist(playlistId, contentId, contentType) {
  return new Promise((resolve, reject) => {
    // First, get the next position
    db.get('SELECT COALESCE(MAX(position), 0) + 1 as next_position FROM playlist_items WHERE playlist_id = ?', [playlistId], (err, row) => {
      if (err) {
        reject(err);
        return;
      }

      const position = row.next_position;
      const stmt = db.prepare('INSERT OR IGNORE INTO playlist_items (playlist_id, content_id, content_type, position) VALUES (?, ?, ?, ?)');
      stmt.run([playlistId, contentId, contentType, position], function(insertErr) {
        if (insertErr) {
          reject(insertErr);
        } else {
          // Update playlist timestamp
          db.run('UPDATE user_playlists SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [playlistId]);
          resolve();
        }
      });
      stmt.finalize();
    });
  });
}

function removeFromPlaylist(playlistId, contentId) {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare('DELETE FROM playlist_items WHERE playlist_id = ? AND content_id = ?');
    stmt.run([playlistId, contentId], function(err) {
      if (err) {
        reject(err);
      } else {
        // Update playlist timestamp
        db.run('UPDATE user_playlists SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [playlistId]);
        resolve();
      }
    });
    stmt.finalize();
  });
}

function getPlaylistItems(playlistId) {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY position', [playlistId], (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

function reorderPlaylistItem(playlistId, contentId, newPosition) {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare('UPDATE playlist_items SET position = ? WHERE playlist_id = ? AND content_id = ?');
    stmt.run([newPosition, playlistId, contentId], function(err) {
      if (err) {
        reject(err);
      } else {
        // Update playlist timestamp
        db.run('UPDATE user_playlists SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [playlistId]);
        resolve();
      }
    });
    stmt.finalize();
  });
}

// Intro detection functions
function getCachedIntroData(contentId, seasonNumber = null, episodeNumber = null) {
  return new Promise((resolve, reject) => {
    let query = 'SELECT * FROM intro_detection_cache WHERE content_id = ?';
    let params = [contentId];

    if (seasonNumber !== null && episodeNumber !== null) {
      query += ' AND season_number = ? AND episode_number = ?';
      params.push(seasonNumber, episodeNumber);
    } else {
      query += ' AND season_number IS NULL AND episode_number IS NULL';
    }

    query += ' AND (expires_at IS NULL OR expires_at > datetime("now"))';

    db.get(query, params, (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row);
      }
    });
  });
}

function setCachedIntroData(contentId, seasonNumber, episodeNumber, introStart, introEnd, source, confidence = 1.0, apiResponse = null, expiresInHours = 24, endingStart = null, endingEnd = null) {
  return new Promise((resolve, reject) => {
    const expiresAt = expiresInHours ? new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString() : null;

    const stmt = db.prepare(`
      INSERT OR REPLACE INTO intro_detection_cache
      (content_id, season_number, episode_number, intro_start, intro_end, ending_start, ending_end, source, confidence, api_response, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run([contentId, seasonNumber, episodeNumber, introStart, introEnd, endingStart, endingEnd, source, confidence, apiResponse, expiresAt], function(err) {
      if (err) {
        reject(err);
      } else {
        resolve(this.lastID);
      }
    });
    stmt.finalize();
  });
}

function submitIntroTimes(userId, contentId, seasonNumber, episodeNumber, introStart, introEnd) {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO user_intro_submissions
      (user_id, content_id, season_number, episode_number, intro_start, intro_end)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run([userId, contentId, seasonNumber, episodeNumber, introStart, introEnd], function(err) {
      if (err) {
        reject(err);
      } else {
        resolve(this.lastID);
      }
    });
    stmt.finalize();
  });
}

function getUserIntroSubmissions(contentId, seasonNumber = null, episodeNumber = null) {
  return new Promise((resolve, reject) => {
    let query = `
      SELECT
        uis.*,
        (uis.votes_up - uis.votes_down) as net_votes,
        COUNT(isv.id) as total_votes
      FROM user_intro_submissions uis
      LEFT JOIN intro_submission_votes isv ON uis.id = isv.submission_id
      WHERE uis.content_id = ?
    `;
    let params = [contentId];

    if (seasonNumber !== null && episodeNumber !== null) {
      query += ' AND uis.season_number = ? AND uis.episode_number = ?';
      params.push(seasonNumber, episodeNumber);
    } else {
      query += ' AND uis.season_number IS NULL AND uis.episode_number IS NULL';
    }

    query += ' GROUP BY uis.id ORDER BY net_votes DESC, total_votes DESC LIMIT 1';

    db.get(query, params, (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row);
      }
    });
  });
}

function voteOnIntroSubmission(userId, submissionId, voteType) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // Remove existing vote
      db.run('DELETE FROM intro_submission_votes WHERE user_id = ? AND submission_id = ?', [userId, submissionId]);

      // Add new vote
      const stmt = db.prepare('INSERT INTO intro_submission_votes (user_id, submission_id, vote_type) VALUES (?, ?, ?)');
      stmt.run([userId, submissionId, voteType], function(err) {
        if (err) {
          reject(err);
          return;
        }

        // Update vote counts
        const updateStmt = db.prepare(`
          UPDATE user_intro_submissions
          SET
            votes_up = (SELECT COUNT(*) FROM intro_submission_votes WHERE submission_id = ? AND vote_type = 'up'),
            votes_down = (SELECT COUNT(*) FROM intro_submission_votes WHERE submission_id = ? AND vote_type = 'down')
          WHERE id = ?
        `);

        updateStmt.run([submissionId, submissionId, submissionId], function(updateErr) {
          if (updateErr) {
            reject(updateErr);
          } else {
            resolve();
          }
        });
        updateStmt.finalize();
      });
      stmt.finalize();
    });
  });
}

function getIntroPreset(contentId, seasonNumber = null) {
  return new Promise((resolve, reject) => {
    let query = 'SELECT * FROM intro_presets WHERE content_id = ?';
    let params = [contentId];

    if (seasonNumber !== null) {
      query += ' AND season_number = ?';
      params.push(seasonNumber);
    } else {
      query += ' AND season_number IS NULL';
    }

    query += ' ORDER BY confidence DESC LIMIT 1';

    db.get(query, params, (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row);
      }
    });
  });
}

function setIntroPreset(contentId, seasonNumber, introStart, introEnd, confidence = 0.5, notes = null) {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO intro_presets
      (content_id, season_number, intro_start, intro_end, confidence, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run([contentId, seasonNumber, introStart, introEnd, confidence, notes], function(err) {
      if (err) {
        reject(err);
      } else {
        resolve(this.lastID);
      }
    });
    stmt.finalize();
  });
}

// Genre preference functions
function saveGenrePreferences(userId, contentType, genreIds) {
  return new Promise((resolve, reject) => {
    const genreIdsJson = JSON.stringify(genreIds);
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO user_genre_preferences (user_id, content_type, genre_ids, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    `);
    stmt.run([userId, contentType, genreIdsJson], function(err) {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
    stmt.finalize();
  });
}

function getGenrePreferences(userId, contentType) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT genre_ids FROM user_genre_preferences WHERE user_id = ? AND content_type = ?',
      [userId, contentType],
      (err, row) => {
        if (err) {
          reject(err);
        } else {
          if (row) {
            try {
              const genreIds = JSON.parse(row.genre_ids);
              resolve(genreIds);
            } catch (parseErr) {
              console.error('Error parsing genre preferences:', parseErr);
              resolve(['all']); // Default fallback
            }
          } else {
            resolve(['all']); // Default if no preferences found
          }
        }
      }
    );
  });
}

// Password and admin management functions
function updateUserPassword(userId, newPassword) {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare('UPDATE users SET password = ? WHERE id = ?');
    stmt.run([newPassword, userId], function(err) {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
    stmt.finalize();
  });
}

function getAllUsersWithPasswords() {
  return new Promise((resolve, reject) => {
    if (!db) {
      console.error('❌ Database not initialized');
      reject(new Error('Database not initialized'));
      return;
    }

    db.all('SELECT id, name, avatar, password, is_admin, created_at, last_active, theme FROM users ORDER BY is_admin DESC, name ASC', (err, rows) => {
      if (err) {
        console.error('❌ Error fetching users with passwords:', err);
        reject(err);
      } else {
        console.log('✅ Fetched', rows.length, 'users with passwords');
        resolve(rows);
      }
    });
  });
}

module.exports = {
  initDatabase,
  createUser,
  getUsers,
  getUserById,
  updateUser,
  getContinueWatching,
  deleteUser,
  updateUserPassword,
  getAllUsersWithPasswords,
  updateUserLastActive,
  updateUserTheme,
  updateUserAvatar,
  updateUserIsAdmin,
  updateUserProgress,
  getUserProgress,
  addToFavorites,
  removeFromFavorites,
  getUserFavorites,
  createPlaylist,
  getUserPlaylists,
  updatePlaylist,
  togglePlaylistHomeDisplay,
  deletePlaylist,
  addToPlaylist,
  removeFromPlaylist,
  getPlaylistItems,
  reorderPlaylistItem,
  getCachedIntroData,
  setCachedIntroData,
  submitIntroTimes,
  getUserIntroSubmissions,
  voteOnIntroSubmission,
  getIntroPreset,
  setIntroPreset,
  saveGenrePreferences,
  getGenrePreferences
};