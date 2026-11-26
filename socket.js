const { Server } = require("socket.io");

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DEFAULT_CHANNELS = ["general", "planning", "updates"];

function hasImageSignature(type, bytes) {
  if (type === "image/png") {
    return bytes.subarray(0, 8).equals(PNG_SIGNATURE);
  }
  if (type === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (type === "image/gif") {
    const header = bytes.toString("ascii", 0, 6);
    return header === "GIF87a" || header === "GIF89a";
  }
  if (type === "image/webp") {
    return bytes.length >= 12 &&
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP";
  }
  return false;
}

function validateImages(images) {
  if (images === undefined) {
    images = [];
  }
  if (!Array.isArray(images)) {
    return { error: "Images must be provided as a list." };
  }
  if (images.length > MAX_IMAGES) {
    return { error: `You can attach up to ${MAX_IMAGES} images per post.` };
  }

  const validatedImages = [];
  for (const image of images) {
    if (
      !image ||
      typeof image.type !== "string" ||
      !ALLOWED_IMAGE_TYPES.has(image.type) ||
      typeof image.dataUrl !== "string"
    ) {
      return { error: "Only PNG, JPG, GIF, and WEBP images are supported." };
    }

    const prefix = `data:${image.type};base64,`;
    if (!image.dataUrl.startsWith(prefix)) {
      return { error: "An image attachment is invalid." };
    }

    const encoded = image.dataUrl.slice(prefix.length);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      return { error: "An image attachment is invalid." };
    }

    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length === 0 || bytes.toString("base64") !== encoded) {
      return { error: "An image attachment is invalid." };
    }
    if (bytes.length > MAX_IMAGE_BYTES) {
      return { error: "Each image must be 1 MB or smaller." };
    }
    if (!hasImageSignature(image.type, bytes)) {
      return { error: "An attachment does not match its image format." };
    }

    validatedImages.push({ type: image.type, dataUrl: image.dataUrl });
  }

  return { images: validatedImages };
}

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function acknowledge(socket, callback, result) {
  if (typeof callback === "function") {
    callback(result);
  }
}

function setupChat(server) {
  const allowedOrigins = (process.env.SOCKET_CORS_ORIGIN || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const io = new Server(server, {
    cors: { origin: allowedOrigins },
    maxHttpBufferSize: 6 * 1024 * 1024
  });
  const posts = [];
  const tasks = [];
  const channels = [...DEFAULT_CHANNELS];
  const members = new Map();
  let nextRecordId = 0;
  let project = {
    name: "Team project",
    description: "A shared space to coordinate work and keep conversations moving."
  };

  function getMemberList() {
    return Array.from(members, ([id, profile]) => ({ id, ...profile }));
  }

  function broadcastMembers() {
    io.emit("members:update", getMemberList());
  }

  io.on("connection", (socket) => {
    socket.emit("project:state", { project, channels, tasks });
    socket.emit("members:update", getMemberList());

    socket.on("profile:update", (data, callback) => {
      const profile = {
        name: cleanText(data?.name, 40),
        role: cleanText(data?.role, 60),
        industry: cleanText(data?.industry, 60),
        team: cleanText(data?.team, 60),
        skills: cleanText(data?.skills, 120)
      };

      if (!profile.name || !profile.role || !profile.industry) {
        acknowledge(socket, callback, {
          success: false,
          error: "Name, role, and industry are required."
        });
        return;
      }

      members.set(socket.id, profile);
      broadcastMembers();
      acknowledge(socket, callback, { success: true, profile });
    });

    socket.on("project:update", (data, callback) => {
      const name = cleanText(data?.name, 80);
      const description = cleanText(data?.description, 240);
      if (!name || !description) {
        acknowledge(socket, callback, {
          success: false,
          error: "Project name and description are required."
        });
        return;
      }

      project = { name, description };
      io.emit("project:update", project);
      acknowledge(socket, callback, { success: true, project });
    });

    socket.on("channel:create", (data, callback) => {
      const name = cleanText(data?.name, 80)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 24);
      if (!name) {
        acknowledge(socket, callback, { success: false, error: "Enter a channel name." });
        return;
      }
      if (channels.includes(name)) {
        acknowledge(socket, callback, { success: false, error: "That channel already exists." });
        return;
      }

      channels.push(name);
      io.emit("channels:update", channels);
      acknowledge(socket, callback, { success: true, channel: name });
    });

    socket.on("channel:join", (data) => {
      const channel = cleanText(data?.channel, 24);
      if (!channels.includes(channel)) {
        return;
      }
      socket.emit("channel:history", {
        channel,
        posts: posts.filter((post) => post.channel === channel)
      });
    });

    socket.on("post:create", (data, callback) => {
      const profile = members.get(socket.id);
      const content = cleanText(data?.content, 3000);
      const channel = cleanText(data?.channel, 24);
      const imageValidation = validateImages(data?.images);
      const replyTo = data?.replyTo;
      let error;

      if (!profile) {
        error = "Save your profile before sending a message.";
      } else if (!channels.includes(channel)) {
        error = "Choose a valid channel.";
      } else if (typeof data?.content === "string" && data.content.trim().length > 3000) {
        error = "Text must be 3000 characters or fewer.";
      } else if (imageValidation.error) {
        error = imageValidation.error;
      } else if (!content && imageValidation.images.length === 0) {
        error = "Add a message or at least one image.";
      }

      if (error) {
        acknowledge(socket, callback, { success: false, error });
        return;
      }

      let safeReply = null;
      if (replyTo && typeof replyTo.id === "string") {
        const repliedPost = posts.find((post) => post.id === replyTo.id && post.channel === channel);
        if (repliedPost) {
          safeReply = {
            id: repliedPost.id,
            author: repliedPost.profile.name,
            content: repliedPost.content.slice(0, 180)
          };
        }
      }

      const post = {
        id: `post-${++nextRecordId}`,
        channel,
        profile,
        content,
        images: imageValidation.images,
        replyTo: safeReply,
        sentAt: new Date().toISOString()
      };
      posts.push(post);
      io.emit("post:new", post);
      acknowledge(socket, callback, { success: true });
    });

    socket.on("task:create", (data, callback) => {
      const title = cleanText(data?.title, 120);
      const assignee = cleanText(data?.assignee, 40);
      if (!title) {
        acknowledge(socket, callback, { success: false, error: "Task title is required." });
        return;
      }

      const task = {
        id: `task-${++nextRecordId}`,
        title,
        assignee,
        completed: false,
        createdBy: members.get(socket.id)?.name || "Project member",
        createdAt: new Date().toISOString()
      };
      tasks.push(task);
      io.emit("task:new", task);
      acknowledge(socket, callback, { success: true });
    });

    socket.on("task:toggle", (data, callback) => {
      const task = tasks.find((item) => item.id === data?.id);
      if (!task) {
        acknowledge(socket, callback, { success: false, error: "Task not found." });
        return;
      }
      task.completed = !task.completed;
      io.emit("task:update", task);
      acknowledge(socket, callback, { success: true });
    });

    socket.on("disconnect", () => {
      if (members.delete(socket.id)) {
        broadcastMembers();
      }
    });
  });

  return io;
}

module.exports = setupChat;
