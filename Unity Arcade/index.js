import express from "express";
import bodyParser from "body-parser";
import pg from "pg";

const db = new pg.Client({
  user: "postgres",
  host: "localhost",
  database: "UnityArcade",
  password: "Partha#2004",
  port: 5432,
});

const app = express();
const port = 3000;
db.connect();

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));

let isLoggedIn = false;
let user = "";

app.get("/", async (req, res) => {
  res.render("home.ejs", {loggedIn : isLoggedIn, details : user});
});

app.get("/browse", async (req, res) => {
  const users = await db.query("SELECT id,username,name FROM users");
  res.render("browse.ejs", {loggedIn : isLoggedIn, details : user, libraries: users.rows});
});

app.get("/games", async (req, res) => {
  const userId = req.query.getId;
  const gameList = await db.query(
    "SELECT title, description, url FROM urls WHERE user_id = $1",
    [userId]
  );
  res.render("games.ejs", {loggedIn : isLoggedIn, details : user, urls: gameList.rows});
});

app.get("/upload", async (req, res) => {
  res.render("upload.ejs", {loggedIn : isLoggedIn, details : user});
});

app.post("/upload", async (req, res) => {
  const gameData = req.body;
  try {
    await db.query(
      "INSERT INTO urls (title, description, url, user_id) VALUES ($1, $2, $3, $4)",
      [gameData.title, gameData.desc, gameData.link, user[0].id]
    );
  } catch (err) {
    console.log(err);
  }
  res.redirect("/upload");
});

app.get("/account", async (req, res) => {
  const loginType = req.query.loginType;
  res.render("login.ejs", {access: loginType, loggedIn : isLoggedIn, details : user});
});

app.get("/faq", async (req, res) => {
  res.render("faq.ejs", {loggedIn : isLoggedIn, details : user});
});

app.post("/login", async (req, res) => {
  const temp = req.body;
  try {
    const userInfo = await db.query(
      "SELECT * FROM users WHERE username = ($1)",
      [temp.username]
    );

    isLoggedIn = true;
    user = userInfo.rows;
  } catch (err) {
    console.log(err);
  }
  res.redirect("/");
});

app.post("/signup", async (req, res) => {
  const temp = req.body;
  try {
    await db.query(
      "INSERT INTO users (username, password_hash, name, email) VALUES ($1, $2, $3, $4)",
      [temp.username, temp.password, temp.displayName, temp.email]
    );
  } catch (err) {
    console.log(err);
  }
  res.redirect("/");
});

app.get("/about", async (req, res) => {
  res.render("about.ejs", {loggedIn : isLoggedIn, details : user});
});

app.get("/edit", async (req, res) => {
  const gameList = await db.query(
    "SELECT title, description, url, id FROM urls WHERE user_id = $1",
    [user[0].id]
  );
  res.render("edit.ejs", {loggedIn : isLoggedIn, details : user, checklist: gameList.rows});
});

app.post("/delete", async (req, res) => {
  const id = req.body.itemId;
  try {
    await db.query("DELETE FROM urls WHERE id = $1 AND user_id = $2", [id, user[0].id]);
    res.redirect("/edit");
  } catch (err) {
    console.log(err);
  }
});

app.post("/editDesc", async (req, res) => {
  const description = req.body.updatedDesc;
  const id = req.body.updatedItemId;

  try {
    await db.query("UPDATE urls SET description = ($1) WHERE id = $2", [description, id]);
    res.redirect("/edit");
  } catch (err) {
    console.log(err);
  }
});

app.post("/editURL", async (req, res) => {
  const url = req.body.updatedUrl;
  const id = req.body.updatedItemId;

  try {
    await db.query("UPDATE urls SET url = ($1) WHERE id = $2", [url, id]);
    res.redirect("/edit");
  } catch (err) {
    console.log(err);
  }
});

app.get("/signout", async (req, res) => {
  isLoggedIn = false;
  user = "";
  res.redirect("/");
});

app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
});