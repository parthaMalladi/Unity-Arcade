import express from "express";
import bodyParser from "body-parser";
import pg from "pg";
import dotenv from "dotenv";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import bcrypt from "bcrypt";

dotenv.config();
const { Pool } = pg;
const poolConfig = {
  max: 5,
  min: 2,
  idleTimeoutMillis: 60000,
  ssl: { rejectUnauthorized: false }
};
const dbUser = process.env.DB_USER;
const password = process.env.PASSWORD;
const host = process.env.HOST;
const dbPort = process.env.DB_PORT;
const database = process.env.DATABASE;

poolConfig.connectionString = `postgresql://${dbUser}:${password}@${host}:${dbPort}/${database}`;
const db = new Pool(poolConfig);

// Pool-level error listener
db.on("error", (err) => {
  console.error("Unexpected database error:", err);
});

const app = express();
const port = process.env.PORT || 3000;
const PgSession = connectPgSimple(session);

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static("public"));

// Render (and most hosts) terminate HTTPS at a proxy and forward plain HTTP internally.
// Without this, Express thinks every request is insecure, so a "secure" cookie never gets set.
app.set("trust proxy", 1);

app.use(session({
  store: new PgSession({
    pool: db,
    tableName: "session",
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24, // 1 day
    httpOnly: true,
    secure: process.env.NODE_ENV === "production"
  }
}));

// Middleware: require the visitor to be logged in
function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.redirect("/account");
  }
  next();
}

app.get("/", async (req, res) => {
  res.render("home.ejs", {
    loggedIn: !!req.session.user,
    details: req.session.user
  });
});

app.get("/browse", async (req, res) => {
  const users = await db.query("SELECT id,username,name FROM clients");
  res.render("browse.ejs", {
    loggedIn: !!req.session.user,
    details: req.session.user,
    libraries: users.rows
  });
});

app.get("/games", async (req, res) => {
  const userId = req.query.getId;
  const viewerId = req.session.user ? req.session.user.id : null;
  const gameList = await db.query(
    `SELECT u.id, u.title, u.description, u.url, u.likes, u.dislikes, gr.reaction AS user_reaction
     FROM urls u
     LEFT JOIN game_reactions gr ON gr.url_id = u.id AND gr.user_id = $2
     WHERE u.user_id = $1`,
    [userId, viewerId]
  );
  res.render("games.ejs", {
    loggedIn: !!req.session.user,
    details: req.session.user,
    urls: gameList.rows
  });
});

app.get("/upload", requireLogin, async (req, res) => {
  res.render("upload.ejs", {
    loggedIn: !!req.session.user,
    details: req.session.user
  });
});

app.post("/upload", requireLogin, async (req, res) => {
  const gameData = req.body;
  try {
    await db.query(
      "INSERT INTO urls (title, description, url, user_id) VALUES ($1, $2, $3, $4)",
      [gameData.title, gameData.desc, gameData.link, req.session.user.id]
    );
  } catch (err) {
    console.log(err);
  }
  res.redirect("/upload");
});

app.post("/feedback", requireLogin, async (req, res) => {
  const { urlId, type } = req.body; // type is "like" or "dislike"
  const userId = req.session.user.id;

  if (type !== "like" && type !== "dislike") {
    return res.status(400).json({ error: "Invalid reaction type" });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query(
      "SELECT reaction FROM game_reactions WHERE user_id = $1 AND url_id = $2",
      [userId, urlId]
    );

    let userReaction;

    if (existing.rows.length === 0) {
      // No prior reaction from this user - add one
      await client.query(
        "INSERT INTO game_reactions (user_id, url_id, reaction) VALUES ($1, $2, $3)",
        [userId, urlId, type]
      );
      const column = type === "like" ? "likes" : "dislikes";
      await client.query(`UPDATE urls SET ${column} = ${column} + 1 WHERE id = $1`, [urlId]);
      userReaction = type;
    } else if (existing.rows[0].reaction === type) {
      // Clicking the same button again - remove the reaction
      await client.query(
        "DELETE FROM game_reactions WHERE user_id = $1 AND url_id = $2",
        [userId, urlId]
      );
      const column = type === "like" ? "likes" : "dislikes";
      await client.query(`UPDATE urls SET ${column} = ${column} - 1 WHERE id = $1`, [urlId]);
      userReaction = null;
    } else {
      // Switching from like to dislike or vice versa
      await client.query(
        "UPDATE game_reactions SET reaction = $1 WHERE user_id = $2 AND url_id = $3",
        [type, userId, urlId]
      );
      const oldColumn = type === "like" ? "dislikes" : "likes";
      const newColumn = type === "like" ? "likes" : "dislikes";
      await client.query(
        `UPDATE urls SET ${oldColumn} = ${oldColumn} - 1, ${newColumn} = ${newColumn} + 1 WHERE id = $1`,
        [urlId]
      );
      userReaction = type;
    }

    const updated = await client.query(
      "SELECT likes, dislikes FROM urls WHERE id = $1",
      [urlId]
    );

    await client.query("COMMIT");

    res.json({
      likes: updated.rows[0].likes,
      dislikes: updated.rows[0].dislikes,
      userReaction
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.log(err);
    res.status(500).json({ error: "Something went wrong" });
  } finally {
    client.release();
  }
});

app.get("/account", async (req, res) => {
  const loginType = req.query.loginType;
  res.render("login.ejs", {
    access: loginType,
    loggedIn: !!req.session.user,
    details: req.session.user
  });
});

app.get("/faq", async (req, res) => {
  res.render("faq.ejs", {
    loggedIn: !!req.session.user,
    details: req.session.user
  });
});

app.post("/login", async (req, res) => {
  const temp = req.body;
  try {
    const userInfo = await db.query(
      "SELECT * FROM clients WHERE username = ($1)",
      [temp.username]
    );

    if (userInfo.rows.length === 0) {
      return res.redirect("/account?loginType=fail");
    }

    const clientRecord = userInfo.rows[0];
    const passwordMatches = await bcrypt.compare(
      temp.password,
      clientRecord.password_hash
    );

    if (!passwordMatches) {
      return res.redirect("/account?loginType=fail");
    }

    req.session.user = clientRecord;
    res.redirect("/");
  } catch (err) {
    console.log(err);
    res.redirect("/account?loginType=fail");
  }
});

app.post("/signup", async (req, res) => {
  const temp = req.body;
  try {
    const hashedPassword = await bcrypt.hash(temp.password, 10);
    await db.query(
      "INSERT INTO clients (username, password_hash, name, email) VALUES ($1, $2, $3, $4)",
      [temp.username, hashedPassword, temp.displayName, temp.email]
    );
  } catch (err) {
    console.log(err);
  }
  res.redirect("/");
});

app.get("/about", async (req, res) => {
  res.render("about.ejs", {
    loggedIn: !!req.session.user,
    details: req.session.user
  });
});

app.get("/edit", requireLogin, async (req, res) => {
  const gameList = await db.query(
    "SELECT title, description, url, id FROM urls WHERE user_id = $1",
    [req.session.user.id]
  );
  res.render("edit.ejs", {
    loggedIn: !!req.session.user,
    details: req.session.user,
    checklist: gameList.rows
  });
});

app.post("/delete", requireLogin, async (req, res) => {
  const id = req.body.itemId;
  try {
    await db.query(
      "DELETE FROM urls WHERE id = $1 AND user_id = $2",
      [id, req.session.user.id]
    );
    res.redirect("/edit");
  } catch (err) {
    console.log(err);
  }
});

app.post("/editDesc", requireLogin, async (req, res) => {
  const description = req.body.updatedDesc;
  const id = req.body.updatedItemId;

  try {
    await db.query(
      "UPDATE urls SET description = ($1) WHERE id = $2 AND user_id = $3",
      [description, id, req.session.user.id]
    );
    res.redirect("/edit");
  } catch (err) {
    console.log(err);
  }
});

app.post("/editURL", requireLogin, async (req, res) => {
  const url = req.body.updatedUrl;
  const id = req.body.updatedItemId;

  try {
    await db.query(
      "UPDATE urls SET url = ($1) WHERE id = $2 AND user_id = $3",
      [url, id, req.session.user.id]
    );
    res.redirect("/edit");
  } catch (err) {
    console.log(err);
  }
});

app.get("/signout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/");
  });
});

app.get("/discussion", async (req, res) => {
  const posts = await db.query("SELECT * FROM forum ORDER BY created_at DESC");
  res.render("discussion.ejs", {
    loggedIn: !!req.session.user,
    details: req.session.user,
    forum: posts.rows
  });
});

app.post("/discussion", requireLogin, async (req, res) => {
  const post = req.body;
  try {
    await db.query(
      "INSERT INTO forum (title, post, user_id) VALUES ($1, $2, $3)",
      [post.title, post.msg, req.session.user.id]
    );
    res.redirect("/discussion");
  } catch (err) {
    console.log(err);
  }
});

app.post("/deleteDiscussion", requireLogin, async (req, res) => {
  const id = req.body.postId;
  try {
    await db.query(
      "DELETE FROM forum WHERE id = $1 AND user_id = $2",
      [id, req.session.user.id]
    );
    res.redirect("/discussion");
  } catch (err) {
    console.log(err);
  }
});

app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
});