require("dotenv").config();
const express = require("express");
const http = require("node:http");

const userController = require("./controllers/userController");
const setupChat = require("./socket");

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 5000;

setupChat(server);

app.use(express.json());

const sendPostsPage = (req, res) => {
  res.sendFile("view/chat.html", { root: __dirname });
};

app.get("/", sendPostsPage);
app.get("/posts", sendPostsPage);
app.get("/chat", sendPostsPage);

app.get("/users", userController.getUsers);     // fetch All records
app.get("/users/:id", userController.getUser);  // filter record
app.post("/users", userController.createUser);  // Add record
app.put("/users/:id", userController.updateUser); // Update record
app.delete("/users/:id", userController.deleteUser); //Delete User

// app.listen(PORT, ()=>{
//   console.log(`Server is running on port ${PORT}`);
// });

server.listen(PORT, ()=>{
  console.log(`Server is running on port ${server.address().port}`);
});

