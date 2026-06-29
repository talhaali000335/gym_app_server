require('dotenv').config();

const express    = require('express');
const mongoose   = require('mongoose');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const cors       = require('cors');
const multer     = require('multer');
const path       = require('path');
const cloudinary = require('cloudinary').v2;
const admin      = require('firebase-admin');

const app = express();

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Check JWT secret ───────────────────────────────────────────────────────────
if (!process.env.JWT_SECRET) {
  console.error('❌  JWT_SECRET is not defined in .env file');
  process.exit(1);
}

// ── Firebase Admin initialisation ─────────────────────────────────────────────
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

    if (admin.apps.length === 0) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    }
    console.log('✅ Firebase Admin SDK initialised');
  } catch (err) {
    console.error('❌ Failed to initialise Firebase Admin:', err.message);
  }
} else {
  console.warn('⚠️  FIREBASE_SERVICE_ACCOUNT not set – push notifications disabled');
}

// ── Cloudinary configuration ───────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── Multer – memory storage ────────────────────────────────────────────────────
const memoryStorage = multer.memoryStorage();

const upload = multer({
  storage:    memoryStorage,
  limits:     { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const isImage = /\.(jpe?g|png|gif|webp)$/i.test(file.originalname);
    isImage ? cb(null, true) : cb(new Error('Only image files (jpg, png, gif, webp) are allowed.'));
  },
});

const uploadAppDocs = multer({
  storage:    memoryStorage,
  limits:     { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /\.(pdf|jpe?g|png|gif|webp)$/i;
    allowed.test(path.extname(file.originalname))
      ? cb(null, true)
      : cb(new Error('Only PDF and image files (jpg, png, gif, webp) are allowed.'));
  },
}).array('documents', 5);

const uploadChatFile = multer({
  storage:    memoryStorage,
  limits:     { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, _file, cb) => cb(null, true),
}).single('file');

const uploadQualification = multer({
  storage:    memoryStorage,
  limits:     { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /\.(pdf|jpe?g|png)$/i;
    allowed.test(path.extname(file.originalname))
      ? cb(null, true)
      : cb(new Error('Only PDF and images allowed for qualifications'));
  },
}).single('document');

const uploadPortfolio = multer({
  storage:    memoryStorage,
  limits:     { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const isImage = /\.(jpe?g|png|gif|webp)$/i.test(file.originalname);
    isImage ? cb(null, true) : cb(new Error('Only image files allowed'));
  },
}).array('images', 10);

// ── MongoDB Connection ─────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('❌ MONGO_URI is not set');
  process.exit(1);
}

let connectionPromise = null;

mongoose.connection.on('disconnected', () => {
  console.warn('⚠️  MongoDB disconnected — will reconnect on next request');
  connectionPromise = null;
});
mongoose.connection.on('error', (err) => {
  console.error('❌ Mongoose connection error:', err.message);
  connectionPromise = null;
});

async function connectToDatabase() {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (mongoose.connection.readyState === 2 && connectionPromise) {
    await connectionPromise;
    return mongoose.connection;
  }
  connectionPromise = mongoose
    .connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 })
    .catch((err) => {
      connectionPromise = null;
      console.error('❌ MongoDB connection failed:', err.message);
      throw err;
    });
  await connectionPromise;
  return mongoose.connection;
}

app.use(async (req, res, next) => {
  try {
    await connectToDatabase();
    next();
  } catch (err) {
    console.error('MongoDB connection error:', err);
    res.status(500).json({ message: 'Database connection failed' });
  }
});

// ── Schemas ────────────────────────────────────────────────────────────────────

const qualificationSchema = new mongoose.Schema(
  {
    certificateName:  { type: String, required: true },
    issuingBy:        { type: String, required: true },
    expirationDate:   { type: Date,   required: true },
    documentUrl:      { type: String, default: '' },
    documentPublicId: { type: String, default: '' },
  },
  { _id: true }
);

const portfolioImageSchema = new mongoose.Schema(
  {
    url:      { type: String, required: true },
    publicId: { type: String, required: true },
  },
  { _id: true }
);

const userSchema = new mongoose.Schema(
  {
    fullName:     { type: String, required: true, trim: true },
    email:        {
      type: String, required: true, unique: true,
      lowercase: true, trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email'],
    },
    phone:        { type: String, required: true, trim: true },
    password:     { type: String, required: true },
    bio:          { type: String, default: '', trim: true },
    role:         { type: String, enum: ['Practitioner', 'Business'], default: 'Practitioner' },
    profilePhoto: { type: String, default: null },
    location:     { type: String, default: '' },
    coordinates: {
      latitude:  { type: Number, default: null },
      longitude: { type: Number, default: null },
    },
    qualifications:  [qualificationSchema],
    portfolioImages: [portfolioImageSchema],
    verificationSettings: {
      expiryReminder:    { type: Boolean, default: true },
      emailReminders:    { type: Boolean, default: true },
      pushNotifications: { type: Boolean, default: false },
      remindDaysBefore:  { type: Number,  default: 15 },
    },
    fcmToken: { type: String, default: null },
  },
  { timestamps: true }
);

userSchema.set('toJSON', {
  transform(_doc, ret) {
    delete ret.password;
    return ret;
  },
});

const User = mongoose.model('User', userSchema);

const availabilitySlotSchema = new mongoose.Schema({
  date:   { type: String, required: true },
  status: { type: String, enum: ['open', 'limited', 'full', 'unavailable'], default: 'open' },
  note:   { type: String, default: '' },
}, { _id: true });

const jobSchema = new mongoose.Schema(
  {
    title:            { type: String, required: true, trim: true },
    company:          { type: String, required: true, trim: true },
    location:         { type: String, required: true },
    salary:           { type: String, required: true },
    jobType:          { type: String, required: true },
    workingPlaceType: { type: String, default: 'Hybrid' },
    description:      { type: String, default: '' },
    requirements:     [{ label: String, value: String }],
    schedule:         [{ label: String, value: String }],
    rate:             { type: String, default: '' },
    distance:         { type: String, default: '' },
    maxClients:       { type: Number, default: null },
    coverTime:        { type: String, default: '' },
    postedBy:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    maxSlots:              { type: Number, default: 16 },
    filledSlots:           { type: Number, default: 0 },
    availabilityCalendar:  [availabilitySlotSchema],
  },
  { timestamps: true }
);

const Job = mongoose.model('Job', jobSchema);

const applicationSchema = new mongoose.Schema(
  {
    job:         { type: mongoose.Schema.Types.ObjectId, ref: 'Job',  required: true },
    applicant:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    fullName:    { type: String, required: true },
    email:       { type: String, required: true },
    phone:       { type: String, required: true },
    coverLetter: { type: String, default: '' },
    status:      { type: String, enum: ['applied', 'withdrawn', 'rejected'], default: 'applied' },
    documents:   [{
      originalName: String,
      url:          String,
      publicId:     String,
    }],
  },
  { timestamps: true }
);

const Application = mongoose.model('Application', applicationSchema);

const conversationSchema = new mongoose.Schema(
  {
    participants: [{
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: true,
    }],
    lastMessage: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'Message',
      default: null,
    },
  },
  { timestamps: true }
);
conversationSchema.index({ participants: 1 });
const Conversation = mongoose.model('Conversation', conversationSchema);

const messageSchema = new mongoose.Schema(
  {
    conversation: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Conversation',
      required: true,
    },
    sender: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: true,
    },
    messageType: {
      type:    String,
      enum:    ['text', 'image', 'video', 'audio', 'file', 'location'],
      default: 'text',
    },
    content:      { type: String, default: '' },
    fileName:     { type: String, default: null },
    fileSize:     { type: Number, default: null },
    latitude:     { type: Number, default: null },
    longitude:    { type: Number, default: null },
    locationName: { type: String, default: null },
    readBy: [{
      type: mongoose.Schema.Types.ObjectId,
      ref:  'User',
    }],
  },
  { timestamps: true }
);
messageSchema.index({ conversation: 1, createdAt: -1 });
const Message = mongoose.model('Message', messageSchema);

const reviewSchema = new mongoose.Schema(
  {
    reviewer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    job:      { type: mongoose.Schema.Types.ObjectId, ref: 'Job', default: null },
    rating:   { type: Number, required: true, min: 1, max: 5 },
    comment:  { type: String, required: true, trim: true, maxlength: 1000 },
  },
  { timestamps: true }
);
reviewSchema.index({ business: 1, createdAt: -1 });
reviewSchema.index({ reviewer: 1, business: 1 }, { unique: true });
const Review = mongoose.model('Review', reviewSchema);

// ── Helpers ────────────────────────────────────────────────────────────────────

const uploadToCloudinary = (buffer, folder, resource_type = 'auto') =>
  new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder, resource_type },
      (error, result) => (error ? reject(error) : resolve(result))
    );
    uploadStream.end(buffer);
  });

const getMessageType = (mimetype) => {
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('video/')) return 'video';
  if (mimetype.startsWith('audio/')) return 'audio';
  return 'file';
};

// ── Authentication middleware ──────────────────────────────────────────────────
const authenticate = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'No token provided.' });
    }
    const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ message: 'Invalid or expired token.' });
  }
};

const onboardingAuth = async (req, res, next) => {
  if (req.user) return next();
  const userId = (req.body?.userId) || req.headers['x-user-id'];
  if (!userId) {
    return res.status(401).json({ message: 'Authentication required. Provide a token or userId.' });
  }
  try {
    const user = await User.findById(userId);
    if (!user) return res.status(401).json({ message: 'Invalid user ID.' });
    req.user = { userId: user._id, email: user.email, role: user.role };
    next();
  } catch (err) {
    res.status(500).json({ message: 'Server error during authentication.' });
  }
};

const isParticipant = (conversation, userId) =>
  conversation.participants.map(String).includes(String(userId));

// ══════════════════════════════════════════════════════════════════════════════
//  PUSH NOTIFICATIONS
// ══════════════════════════════════════════════════════════════════════════════

const TYPE_TO_CHANNEL = {
  new_message:     'covrly_messages',
  message:         'covrly_messages',
  job:             'covrly_jobs',
  job_application: 'covrly_applications',
  application:     'covrly_applications',
  certificate:     'covrly_certificates',
  review:          'covrly_reviews',
};

const sendPushNotification = async (userId, title, body, data = {}) => {
  try {
    if (!admin.apps || admin.apps.length === 0) return;

    const user = await User.findById(userId).select('fcmToken');
    if (!user?.fcmToken) {
      console.log(`⚠️  No FCM token for user ${userId}`);
      return;
    }

    const stringData = {};
    for (const [k, v] of Object.entries(data)) stringData[k] = String(v);

    const type      = data.type || 'general';
    const channelId = TYPE_TO_CHANNEL[type] || 'covrly_default_channel';

    const message = {
      token: user.fcmToken,
      notification: { title: String(title), body: String(body) },
      android: {
        priority: 'high',
        notification: {
          channelId,
          sound:                 'default',
          defaultVibrateTimings: true,
          notificationPriority:  'PRIORITY_HIGH',
          visibility:            'PUBLIC',
          clickAction:           'FLUTTER_NOTIFICATION_CLICK',
        },
      },
      data: { type, title: String(title), body: String(body), ...stringData },
    };

    const response = await admin.messaging().send(message);
    console.log(`📲 Push [${type}] → user ${userId}: ${response}`);
    return response;
  } catch (error) {
    console.error(`❌ FCM error [${data.type}] user ${userId}:`, error.code, error.message);
    if (
      error.code === 'messaging/invalid-registration-token' ||
      error.code === 'messaging/registration-token-not-registered'
    ) {
      await User.findByIdAndUpdate(userId, { fcmToken: null });
      console.log(`🗑️  Removed stale FCM token for user ${userId}`);
    }
  }
};

const sendMessageNotification = (recipientId, senderName, text, conversationId) =>
  sendPushNotification(
    recipientId,
    senderName,
    text.length > 80 ? text.substring(0, 80) + '…' : text,
    { type: 'new_message', conversationId }
  );

const sendApplicationNotification = (businessId, applicantName, jobTitle, jobId) =>
  sendPushNotification(
    businessId,
    'New Application',
    `${applicantName} applied for ${jobTitle}`,
    { type: 'job_application', jobId }
  );

const sendJobNotification = (userId, jobTitle, company, jobId) =>
  sendPushNotification(
    userId,
    `New Job: ${jobTitle}`,
    `${company} is hiring`,
    { type: 'job', jobId }
  );

const sendCertificateNotification = (userId, certName, daysLeft) =>
  sendPushNotification(
    userId,
    'Certificate Expiring Soon',
    `${certName} expires in ${daysLeft} days`,
    { type: 'certificate', certName }
  );

const sendReviewNotification = (businessId, reviewerName, rating) =>
  sendPushNotification(
    businessId,
    'New Review',
    `${reviewerName} gave you ${rating} stars`,
    { type: 'review', rating }
  );

// ── Test push endpoint ─────────────────────────────────────────────────────────
app.post('/api/test-push', async (req, res) => {
  try {
    const { userId, title = 'Test', body = 'Push is working! 🎉', token } = req.body;
    if (token) {
      if (!admin.apps || admin.apps.length === 0) {
        return res.status(500).json({ message: 'Firebase Admin not initialised' });
      }
      const message = {
        token,
        notification: { title, body },
        android: {
          priority: 'high',
          notification: {
            channelId:             'covrly_default_channel',
            sound:                 'default',
            defaultVibrateTimings: true,
            notificationPriority:  'PRIORITY_HIGH',
            visibility:            'PUBLIC',
            clickAction:           'FLUTTER_NOTIFICATION_CLICK',
          },
        },
        data: { type: 'test', title, body },
      };
      const response = await admin.messaging().send(message);
      return res.json({ success: true, response });
    }
    if (!userId) {
      return res.status(400).json({ message: 'Provide userId or token' });
    }
    await sendPushNotification(userId, title, body, { type: 'test' });
    res.json({ success: true, message: `Notification sent to user ${userId}` });
  } catch (err) {
    console.error('Test push error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/register', upload.single('profilePhoto'), async (req, res) => {
  try {
    const { fullName, email, phone, password, bio, role } = req.body;

    if (!fullName || !email || !phone || !password)
      return res.status(400).json({ message: 'fullName, email, phone, and password are all required.' });
    if (password.length < 6)
      return res.status(400).json({ message: 'Password must be at least 6 characters.' });

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(409).json({ message: 'An account with this email already exists.' });

    let profilePhotoUrl = null;
    if (req.file) {
      const result = await uploadToCloudinary(req.file.buffer, 'profile_photos', 'image');
      profilePhotoUrl = result.secure_url;
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const user = await User.create({
      fullName, email, phone,
      password: hashedPassword,
      bio:      bio  || '',
      role:     role || 'Practitioner',
      profilePhoto: profilePhotoUrl,
    });

    console.log(`👤  New user created → ${user._id} (${user.email})`);
    return res.status(201).json({ message: 'Profile created successfully.', userId: user._id, user });
  } catch (err) {
    console.error('Register error:', err.message);
    if (err.code === 11000) return res.status(409).json({ message: 'Email already in use.' });
    if (err.name === 'ValidationError') {
      const messages = Object.values(err.errors).map(e => e.message);
      return res.status(400).json({ message: messages.join(' | ') });
    }
    return res.status(500).json({ message: 'Server error. Please try again.' });
  }
});

app.post('/api/register/complete', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ message: 'userId is required.' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    const token = jwt.sign(
      { userId: user._id, email: user.email, role: user.role, fullName: user.fullName },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log(`🔐 Final token issued for user ${user.email}`);
    res.json({ token, user: user.toJSON() });
  } catch (err) {
    console.error('Complete registration error:', err);
    res.status(500).json({ message: 'Server error.' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email and password required.' });

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(401).json({ message: 'Invalid email or password.' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ message: 'Invalid email or password.' });

    const token = jwt.sign(
      { userId: user._id, email: user.email, role: user.role, fullName: user.fullName },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log(`🔓  User logged in → ${user.email}`);
    res.status(200).json({ message: 'Login successful', token, user: user.toJSON() });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'Server error. Please try again.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  SOCIAL AUTH ROUTES  (Google, Facebook, X)
// ══════════════════════════════════════════════════════════════════════════════

// Google Sign-In
app.post('/api/auth/google', async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ message: 'idToken required' });

    // Verify Google token via public endpoint
    const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`);
    if (!response.ok) {
      return res.status(401).json({ message: 'Invalid Google token' });
    }
    const payload = await response.json();
    const { email, name, picture } = payload;

    if (!email) {
      return res.status(401).json({ message: 'Email not provided by Google' });
    }

    let user = await User.findOne({ email });
    if (!user) {
      user = new User({
        fullName: name || email.split('@')[0],
        email,
        phone: '',
        password: await bcrypt.hash(Math.random().toString(36), 10),
        profilePhoto: picture || null,
        role: 'Practitioner',
      });
      await user.save();
    }

    const token = jwt.sign(
      { userId: user._id, email: user.email, role: user.role, fullName: user.fullName },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ token, user: user.toJSON() });
  } catch (err) {
    console.error('Google auth error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Facebook (Meta) Sign-In
app.post('/api/auth/facebook', async (req, res) => {
  try {
    const { accessToken } = req.body;
    if (!accessToken) return res.status(400).json({ message: 'accessToken required' });

    const fbResponse = await fetch(
      `https://graph.facebook.com/me?access_token=${accessToken}&fields=id,name,email,picture`
    );
    if (!fbResponse.ok) {
      return res.status(401).json({ message: 'Invalid Facebook token' });
    }
    const data = await fbResponse.json();

    if (!data.email) {
      return res.status(401).json({ message: 'Email not provided by Facebook' });
    }

    const { email, name, picture } = data;
    let user = await User.findOne({ email });
    if (!user) {
      user = new User({
        fullName: name || email.split('@')[0],
        email,
        phone: '',
        password: await bcrypt.hash(Math.random().toString(36), 10),
        profilePhoto: picture?.data?.url || null,
        role: 'Practitioner',
      });
      await user.save();
    }

    const token = jwt.sign(
      { userId: user._id, email: user.email, role: user.role, fullName: user.fullName },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ token, user: user.toJSON() });
  } catch (err) {
    console.error('Facebook auth error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// X (Twitter) Sign-In
app.post('/api/auth/x', async (req, res) => {
  try {
    const { accessToken } = req.body;
    if (!accessToken) return res.status(400).json({ message: 'accessToken required' });

    const twitterResponse = await fetch('https://api.twitter.com/2/users/me', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });
    if (!twitterResponse.ok) {
      return res.status(401).json({ message: 'Invalid Twitter token' });
    }
    const data = await twitterResponse.json();

    if (!data.data) {
      return res.status(401).json({ message: 'Invalid Twitter response' });
    }

    const twitterId = data.data.id;
    const name = data.data.name || 'Twitter User';
    // Twitter v2 doesn't return email by default; fallback to a placeholder
    const email = `${twitterId}@twitter.com`;

    // Optional: request email with user:email scope – if your token has that scope:
    // const emailResponse = await fetch('https://api.twitter.com/2/users/me?user.fields=email', { headers: { Authorization: `Bearer ${accessToken}` } });
    // const emailData = await emailResponse.json();
    // const email = emailData.data?.email || `${twitterId}@twitter.com`;

    let user = await User.findOne({ email });
    if (!user) {
      user = new User({
        fullName: name,
        email,
        phone: '',
        password: await bcrypt.hash(Math.random().toString(36), 10),
        profilePhoto: null,
        role: 'Practitioner',
      });
      await user.save();
    }

    const token = jwt.sign(
      { userId: user._id, email: user.email, role: user.role, fullName: user.fullName },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ token, user: user.toJSON() });
  } catch (err) {
    console.error('Twitter auth error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  PROFILE & OTHER ROUTES (unchanged)
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/profile', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ message: 'User not found.' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── FCM token update ──────────────────────────────────────────────────────────
app.put('/api/users/me/token', authenticate, async (req, res) => {
  try {
    const { fcmToken } = req.body;
    if (!fcmToken) return res.status(400).json({ message: 'fcmToken is required.' });
    await User.findByIdAndUpdate(req.user.userId, { fcmToken });
    console.log(`📱 FCM token updated for user ${req.user.userId}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  PROFILE SETUP ROUTES (location, qualifications, portfolio, verification, etc.)
// ══════════════════════════════════════════════════════════════════════════════

app.put('/api/profile/location', onboardingAuth, async (req, res) => {
  try {
    const { location, latitude, longitude } = req.body;
    const id = req.user.userId;
    const update = { location: location || '' };
    if (latitude != null && longitude != null) {
      update.coordinates = {
        latitude:  Number(latitude),
        longitude: Number(longitude),
      };
    }
    const user = await User.findByIdAndUpdate(id, update, { new: true });
    if (!user) return res.status(404).json({ message: 'User not found.' });
    res.json({ message: 'Location updated', user });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/profile/qualifications', onboardingAuth, (req, res) => {
  uploadQualification(req, res, async (err) => {
    if (err) return res.status(400).json({ message: err.message });
    try {
      const { certificateName, issuingBy, expirationDate } = req.body;
      if (!certificateName || !issuingBy || !expirationDate)
        return res.status(400).json({ message: 'certificateName, issuingBy, and expirationDate are required.' });

      let documentUrl      = '';
      let documentPublicId = '';
      if (req.file) {
        const result = await uploadToCloudinary(req.file.buffer, 'qualifications');
        documentUrl      = result.secure_url;
        documentPublicId = result.public_id;
      }

      const qualification = {
        certificateName,
        issuingBy,
        expirationDate:   new Date(expirationDate),
        documentUrl,
        documentPublicId,
      };

      const user = await User.findByIdAndUpdate(
        req.user.userId,
        { $push: { qualifications: qualification } },
        { new: true }
      );
      if (!user) return res.status(404).json({ message: 'User not found.' });
      res.status(201).json({ message: 'Qualification added', user });
    } catch (error) {
      console.error('Add qualification error:', error);
      res.status(500).json({ message: 'Server error.' });
    }
  });
});

app.delete('/api/profile/qualifications/:qualId', authenticate, async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.user.userId,
      { $pull: { qualifications: { _id: req.params.qualId } } },
      { new: true }
    );
    if (!user) return res.status(404).json({ message: 'User not found.' });
    res.json({ message: 'Qualification removed', user });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/profile/portfolio', onboardingAuth, (req, res) => {
  uploadPortfolio(req, res, async (err) => {
    if (err) return res.status(400).json({ message: err.message });
    try {
      if (!req.files || req.files.length === 0)
        return res.status(400).json({ message: 'At least one image is required.' });

      const images = [];
      for (const file of req.files) {
        const result = await uploadToCloudinary(file.buffer, 'portfolio', 'image');
        images.push({ url: result.secure_url, publicId: result.public_id });
      }

      const user = await User.findByIdAndUpdate(
        req.user.userId,
        { $push: { portfolioImages: { $each: images } } },
        { new: true }
      );
      if (!user) return res.status(404).json({ message: 'User not found.' });
      res.status(201).json({ message: 'Portfolio images added', user });
    } catch (error) {
      console.error('Add portfolio error:', error);
      res.status(500).json({ message: 'Server error.' });
    }
  });
});

app.delete('/api/profile/portfolio/:imageId', authenticate, async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.user.userId,
      { $pull: { portfolioImages: { _id: req.params.imageId } } },
      { new: true }
    );
    if (!user) return res.status(404).json({ message: 'User not found.' });
    res.json({ message: 'Portfolio image removed', user });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.put('/api/profile/verification', onboardingAuth, async (req, res) => {
  try {
    const { expiryReminder, emailReminders, pushNotifications, remindDaysBefore } = req.body;
    const settings = {};
    if (expiryReminder    !== undefined) settings['verificationSettings.expiryReminder']    = expiryReminder;
    if (emailReminders    !== undefined) settings['verificationSettings.emailReminders']    = emailReminders;
    if (pushNotifications !== undefined) settings['verificationSettings.pushNotifications'] = pushNotifications;
    if (remindDaysBefore  !== undefined) settings['verificationSettings.remindDaysBefore']  = Number(remindDaysBefore);

    const user = await User.findByIdAndUpdate(req.user.userId, { $set: settings }, { new: true });
    if (!user) return res.status(404).json({ message: 'User not found.' });
    res.json({ message: 'Verification settings updated', user });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.put('/api/profile', authenticate, upload.single('profilePhoto'), async (req, res) => {
  try {
    const { fullName, email, phone, bio } = req.body;
    const update = {};

    if (fullName !== undefined) update.fullName = fullName;
    if (email !== undefined) {
      if (email !== req.user.email) {
        const existing = await User.findOne({ email: email.toLowerCase() });
        if (existing && existing._id.toString() !== req.user.userId) {
          return res.status(409).json({ message: 'Email already in use by another account.' });
        }
      }
      update.email = email;
    }
    if (phone !== undefined) update.phone = phone;
    if (bio   !== undefined) update.bio   = bio;

    if (req.file) {
      const result = await uploadToCloudinary(req.file.buffer, 'profile_photos', 'image');
      update.profilePhoto = result.secure_url;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ message: 'No fields to update provided.' });
    }

    const user = await User.findByIdAndUpdate(req.user.userId, update, { new: true, runValidators: true });
    if (!user) return res.status(404).json({ message: 'User not found.' });
    res.json({ message: 'Profile updated', user: user.toJSON() });
  } catch (err) {
    console.error('Update profile error:', err);
    if (err.name === 'ValidationError') {
      const messages = Object.values(err.errors).map(e => e.message);
      return res.status(400).json({ message: messages.join(' | ') });
    }
    res.status(500).json({ message: 'Server error. Please try again.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  JOB ROUTES (unchanged)
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/jobs', async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 10);
    const skip  = (page - 1) * limit;

    const [jobs, totalCount] = await Promise.all([
      Job.find()
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('postedBy', 'fullName email'),
      Job.countDocuments(),
    ]);

    res.json({
      jobs,
      currentPage: page,
      totalPages:  Math.ceil(totalCount / limit),
      totalCount,
      hasMore:     page < Math.ceil(totalCount / limit),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/jobs/:id', async (req, res) => {
  try {
    const job = await Job.findById(req.params.id).populate('postedBy', 'fullName email');
    if (!job) return res.status(404).json({ message: 'Job not found.' });
    res.json(job);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/jobs', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'Business')
      return res.status(403).json({ message: 'Only Business accounts can post jobs.' });

    const {
      title, company, location, salary, jobType, workingPlaceType,
      description, requirements, schedule, rate, distance, maxClients,
      coverTime, maxSlots,
    } = req.body;

    if (!title || !company || !location || !salary || !jobType)
      return res.status(400).json({ message: 'Missing required fields.' });

    const job = await Job.create({
      title, company, location, salary, jobType, workingPlaceType,
      description, requirements, schedule, rate, distance, maxClients,
      coverTime, maxSlots: maxSlots || 16,
      postedBy: req.user.userId,
    });

    try {
      const practitioners = await User.find({ role: 'Practitioner', fcmToken: { $ne: null } })
        .select('_id')
        .lean();
      console.log(`📢 Notifying ${practitioners.length} practitioners about: ${title}`);
      const results = await Promise.allSettled(
        practitioners.map((p) =>
          sendJobNotification(p._id, title, company, job._id.toString())
        )
      );
      const sent   = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.filter((r) => r.status === 'rejected').length;
      console.log(`📢 Job notifications: ${sent} sent, ${failed} failed`);
    } catch (notifyErr) {
      console.error('Job notification batch error:', notifyErr.message);
    }

    res.status(201).json({ message: 'Job posted successfully', job });
  } catch (err) {
    console.error('Job creation error:', err);
    if (err.name === 'ValidationError') {
      const messages = Object.values(err.errors).map((e) => e.message);
      return res.status(400).json({ message: messages.join(' | ') });
    }
    res.status(500).json({ message: 'Server error. Please try again.' });
  }
});

app.put('/api/jobs/:id/availability', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'Business') {
      return res.status(403).json({ message: 'Only Business accounts can update availability.' });
    }
    const { availabilityCalendar } = req.body;
    const job = await Job.findOne({ _id: req.params.id, postedBy: req.user.userId });
    if (!job) return res.status(404).json({ message: 'Job not found or not owned by you.' });
    job.availabilityCalendar = availabilityCalendar || [];
    await job.save();
    res.json({ message: 'Availability updated.', job });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/jobs/:id/availability', async (req, res) => {
  try {
    const job = await Job.findById(req.params.id).select('availabilityCalendar maxSlots filledSlots title company');
    if (!job) return res.status(404).json({ message: 'Job not found.' });
    const availableSlots = job.maxSlots - job.filledSlots;
    res.json({
      calendar: job.availabilityCalendar || [],
      maxSlots: job.maxSlots,
      filledSlots: job.filledSlots,
      availableSlots,
      isFull: availableSlots <= 0,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/jobs/:id/apply', authenticate, (req, res) => {
  uploadAppDocs(req, res, async (err) => {
    if (err) return res.status(400).json({ message: err.message });
    try {
      const job = await Job.findById(req.params.id);
      if (!job) return res.status(404).json({ message: 'Job not found.' });
      if (job.filledSlots >= job.maxSlots) {
        return res.status(400).json({ message: 'This job is no longer accepting applications. All slots are filled.' });
      }

      const { fullName, email, phone, coverLetter } = req.body;
      if (!fullName || !email || !phone)
        return res.status(400).json({ message: 'fullName, email, and phone are required.' });

      const documents = [];
      if (req.files && req.files.length > 0) {
        for (const file of req.files) {
          const result = await uploadToCloudinary(file.buffer, 'application_documents');
          documents.push({
            originalName: file.originalname,
            url:          result.secure_url,
            publicId:     result.public_id,
          });
        }
      }

      const application = await Application.create({
        job: job._id, applicant: req.user.userId,
        fullName, email, phone,
        coverLetter: coverLetter || '',
        documents,
      });

      job.filledSlots += 1;
      await job.save();

      console.log(`📨 New application for "${job.title}" by ${email}. Slots: ${job.filledSlots}/${job.maxSlots}`);

      await sendApplicationNotification(
        job.postedBy,
        fullName,
        job.title,
        job._id.toString()
      );

      res.status(201).json({
        message: 'Application submitted successfully.',
        application,
        slotsLeft: job.maxSlots - job.filledSlots,
      });
    } catch (error) {
      console.error('Apply error:', error);
      res.status(500).json({ message: 'Server error. Please try again.' });
    }
  });
});

app.get('/api/applications/me', authenticate, async (req, res) => {
  try {
    const applications = await Application.find({ applicant: req.user.userId })
      .populate({
        path: 'job',
        populate: { path: 'postedBy', select: '_id fullName email' },
      })
      .sort({ createdAt: -1 });

    const enriched = applications.map(app => ({
      ...app.toObject(),
      slotsLeft: app.job ? app.job.maxSlots - app.job.filledSlots : 0,
      isFull: app.job ? app.job.filledSlots >= app.job.maxSlots : true,
    }));

    res.json({ count: enriched.length, applications: enriched });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.patch('/api/applications/:id/withdraw', authenticate, async (req, res) => {
  try {
    const app = await Application.findOneAndUpdate(
      { _id: req.params.id, applicant: req.user.userId },
      { status: 'withdrawn' },
      { new: true }
    );
    if (!app) return res.status(404).json({ message: 'Application not found' });
    res.json({ message: 'Application withdrawn', application: app });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  REVIEW ROUTES (unchanged)
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/reviews', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'Practitioner') {
      return res.status(403).json({ message: 'Only Practitioners can submit reviews.' });
    }
    const { businessId, jobId, rating, comment } = req.body;
    if (!businessId || !rating || !comment) {
      return res.status(400).json({ message: 'businessId, rating, and comment are required.' });
    }
    if (rating < 1 || rating > 5) {
      return res.status(400).json({ message: 'Rating must be between 1 and 5.' });
    }

    const business = await User.findById(businessId);
    if (!business || business.role !== 'Business') {
      return res.status(404).json({ message: 'Business account not found.' });
    }

    if (jobId) {
      const application = await Application.findOne({
        applicant: req.user.userId,
        job: jobId,
      }).populate('job');
      if (!application || application.job.postedBy.toString() !== businessId) {
        return res.status(403).json({ message: 'You can only review businesses after applying to their job.' });
      }
    }

    const review = await Review.create({
      reviewer: req.user.userId,
      business: businessId,
      job: jobId || null,
      rating,
      comment,
    });

    const reviewer = req.user.fullName
      ? { fullName: req.user.fullName }
      : await User.findById(req.user.userId).select('fullName');

    await sendReviewNotification(businessId, reviewer?.fullName || 'Someone', rating);

    res.status(201).json({ message: 'Review submitted successfully.', review });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: 'You have already reviewed this business.' });
    }
    console.error('Review error:', err);
    res.status(500).json({ message: 'Server error.' });
  }
});

app.get('/api/reviews/business/:businessId', async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 10);
    const skip  = (page - 1) * limit;

    const [reviews, totalCount, stats] = await Promise.all([
      Review.find({ business: req.params.businessId })
        .populate('reviewer', 'fullName profilePhoto')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Review.countDocuments({ business: req.params.businessId }),
      Review.aggregate([
        { $match: { business: new mongoose.Types.ObjectId(req.params.businessId) } },
        {
          $group: {
            _id: null,
            avgRating: { $avg: '$rating' },
            totalReviews: { $sum: 1 },
            fiveStar: { $sum: { $cond: [{ $eq: ['$rating', 5] }, 1, 0] } },
            fourStar: { $sum: { $cond: [{ $eq: ['$rating', 4] }, 1, 0] } },
            threeStar: { $sum: { $cond: [{ $eq: ['$rating', 3] }, 1, 0] } },
            twoStar: { $sum: { $cond: [{ $eq: ['$rating', 2] }, 1, 0] } },
            oneStar: { $sum: { $cond: [{ $eq: ['$rating', 1] }, 1, 0] } },
          },
        },
      ]),
    ]);

    const summary = stats[0] || {
      avgRating: 0, totalReviews: 0,
      fiveStar: 0, fourStar: 0, threeStar: 0, twoStar: 0, oneStar: 0,
    };

    res.json({
      reviews,
      summary: {
        ...summary,
        avgRating: Math.round(summary.avgRating * 10) / 10,
      },
      currentPage: page,
      totalPages: Math.ceil(totalCount / limit),
      totalCount,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/reviews/me', authenticate, async (req, res) => {
  try {
    const reviews = await Review.find({ reviewer: req.user.userId })
      .populate('business', 'fullName profilePhoto company')
      .sort({ createdAt: -1 });
    res.json({ reviews });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.delete('/api/reviews/:id', authenticate, async (req, res) => {
  try {
    const review = await Review.findOneAndDelete({
      _id: req.params.id,
      reviewer: req.user.userId,
    });
    if (!review) return res.status(404).json({ message: 'Review not found.' });
    res.json({ message: 'Review deleted.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  USER ROUTES (unchanged)
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/users', async (_req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 });
    res.json({ count: users.length, users });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found.' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/contacts', authenticate, async (req, res) => {
  try {
    const userId = req.user.userId;
    const currentUser = await User.findById(userId);
    if (!currentUser) return res.status(404).json({ message: 'User not found' });

    let contactIds = [];

    if (currentUser.role === 'Practitioner') {
      const applications = await Application.find({ applicant: userId }).populate({
        path: 'job',
        populate: { path: 'postedBy', select: '_id' }
      });
      const businessIds = new Set();
      applications.forEach(app => {
        if (app.job && app.job.postedBy) {
          businessIds.add(app.job.postedBy._id.toString());
        }
      });
      contactIds = Array.from(businessIds);
    } else if (currentUser.role === 'Business') {
      const jobs = await Job.find({ postedBy: userId }).select('_id');
      const jobIds = jobs.map(j => j._id);
      const applications = await Application.find({ job: { $in: jobIds } }).select('applicant');
      const practitionerIds = new Set();
      applications.forEach(app => {
        practitionerIds.add(app.applicant.toString());
      });
      contactIds = Array.from(practitionerIds);
    } else {
      contactIds = [];
    }

    const contacts = await User.find({ _id: { $in: contactIds } })
      .select('fullName profilePhoto role')
      .sort({ fullName: 1 });

    res.json({ contacts });
  } catch (err) {
    console.error('Contacts error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  CHAT ROUTES (unchanged)
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/conversations', authenticate, async (req, res) => {
  try {
    const userId = req.user.userId;
    const conversations = await Conversation.find({ participants: userId })
      .populate('participants', 'fullName profilePhoto')
      .populate('lastMessage')
      .sort({ updatedAt: -1 });

    const enriched = await Promise.all(
      conversations.map(async (conv) => {
        const unreadCount = await Message.countDocuments({
          conversation: conv._id,
          readBy: { $ne: userId },
          sender: { $ne: userId },
        });
        const otherParticipant = conv.participants.find(
          (p) => p._id.toString() !== userId.toString()
        );
        return {
          _id:         conv._id,
          otherUser:   otherParticipant,
          lastMessage: conv.lastMessage,
          unreadCount,
          updatedAt:   conv.updatedAt,
        };
      })
    );
    res.json({ conversations: enriched });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/conversations', authenticate, async (req, res) => {
  try {
    const { otherUserId } = req.body;
    if (!otherUserId) return res.status(400).json({ message: 'otherUserId required' });
    const userId = req.user.userId;
    if (userId === otherUserId)
      return res.status(400).json({ message: 'Cannot start conversation with yourself' });

    const currentUser = await User.findById(userId);
    const otherUser   = await User.findById(otherUserId);
    if (!currentUser || !otherUser) return res.status(404).json({ message: 'User not found' });

    let allowed = false;
    if (currentUser.role === 'Practitioner' && otherUser.role === 'Business') {
      const application = await Application.findOne({ applicant: userId }).populate('job');
      if (application && application.job && application.job.postedBy.toString() === otherUserId) {
        allowed = true;
      }
    } else if (currentUser.role === 'Business' && otherUser.role === 'Practitioner') {
      const job = await Job.findOne({ postedBy: userId });
      if (job) {
        const application = await Application.findOne({ applicant: otherUserId, job: job._id });
        if (application) allowed = true;
      }
    }
    if (!allowed) {
      return res.status(403).json({ message: 'You are not allowed to chat with this user' });
    }

    let conversation = await Conversation.findOne({
      participants: { $all: [userId, otherUserId] },
    }).populate('participants', 'fullName profilePhoto');
    if (conversation) return res.json({ conversation });

    conversation = await Conversation.create({ participants: [userId, otherUserId] });
    await conversation.populate('participants', 'fullName profilePhoto');
    res.status(201).json({ conversation });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/conversations/:id/messages', authenticate, async (req, res) => {
  try {
    const conversationId = req.params.id;
    const { page = 1, limit = 30, after } = req.query;
    const filter = { conversation: conversationId };
    if (after) filter.createdAt = { $gt: new Date(after) };
    const skip     = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);
    const messages = await Message.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .populate('sender', 'fullName profilePhoto');
    const total = await Message.countDocuments({ conversation: conversationId });
    res.json({
      messages:    messages.reverse(),
      currentPage: parseInt(page),
      totalPages:  Math.ceil(total / parseInt(limit)),
      totalCount:  total,
      hasMore:     skip + messages.length < total,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/conversations/:id/messages', authenticate, (req, res) => {
  uploadChatFile(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError)
        return res.status(400).json({ message: `Upload error: ${err.message}` });
      return res.status(400).json({ message: err.message });
    }
    try {
      const conversation = await Conversation.findById(req.params.id);
      if (!conversation) return res.status(404).json({ message: 'Conversation not found' });
      if (!isParticipant(conversation, req.user.userId))
        return res.status(403).json({ message: 'Not a participant' });

      let messageData = {
        conversation: conversation._id,
        sender:       req.user.userId,
        readBy:       [req.user.userId],
      };

      if (req.body.text && !req.file) {
        messageData.messageType = 'text';
        messageData.content     = req.body.text;
      } else if (req.file) {
        const result = await uploadToCloudinary(req.file.buffer, 'chat_files', 'auto');
        messageData.messageType = getMessageType(req.file.mimetype);
        messageData.content     = result.secure_url;
        messageData.fileName    = req.file.originalname;
        messageData.fileSize    = req.file.size;
      } else {
        return res.status(400).json({ message: 'Text or file is required' });
      }

      const message = await Message.create(messageData);
      await message.populate('sender', 'fullName profilePhoto');
      conversation.lastMessage = message._id;
      await conversation.save();

      const recipients = conversation.participants.filter(
        (p) => p.toString() !== req.user.userId.toString()
      );
      const sender = await User.findById(req.user.userId).select('fullName');
      const senderName = sender?.fullName || 'Someone';
      const notificationBody = req.body.text ? req.body.text : '📎 Sent an attachment';

      await Promise.allSettled(
        recipients.map((recipientId) =>
          sendMessageNotification(
            recipientId,
            senderName,
            notificationBody,
            conversation._id.toString()
          )
        )
      );

      res.status(201).json({ message });
    } catch (error) {
      console.error('Send message error:', error);
      res.status(500).json({ message: 'Server error' });
    }
  });
});

app.get('/api/cloudinary/signature', authenticate, (req, res) => {
  try {
    const folder    = req.query.folder || 'chat_files';
    const timestamp = Math.round(Date.now() / 1000);
    const signature = cloudinary.utils.api_sign_request(
      { timestamp, folder },
      process.env.CLOUDINARY_API_SECRET
    );
    res.json({
      signature,
      timestamp,
      apiKey:    process.env.CLOUDINARY_API_KEY,
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      folder,
    });
  } catch (err) {
    console.error('Cloudinary signature error:', err);
    res.status(500).json({ message: 'Could not create upload signature' });
  }
});

app.post('/api/conversations/:id/messages/attachment', authenticate, async (req, res) => {
  try {
    const conversation = await Conversation.findById(req.params.id);
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });
    if (!isParticipant(conversation, req.user.userId))
      return res.status(403).json({ message: 'Not a participant' });

    const { url, fileName, fileSize, resourceType } = req.body;
    if (!url) return res.status(400).json({ message: 'url is required' });

    let messageType = 'file';
    if (resourceType === 'image') messageType = 'image';
    else if (resourceType === 'audio') messageType = 'audio';
    else if (resourceType === 'video') messageType = 'video';

    const message = await Message.create({
      conversation: conversation._id,
      sender:       req.user.userId,
      readBy:       [req.user.userId],
      messageType,
      content:      url,
      fileName:     fileName || null,
      fileSize:     fileSize || null,
    });
    await message.populate('sender', 'fullName profilePhoto');
    conversation.lastMessage = message._id;
    await conversation.save();
    res.status(201).json({ message });
  } catch (error) {
    console.error('Attachment message error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/conversations/:id/messages/location', authenticate, async (req, res) => {
  try {
    const conversation = await Conversation.findById(req.params.id);
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });
    if (!isParticipant(conversation, req.user.userId))
      return res.status(403).json({ message: 'Not a participant' });

    const { latitude, longitude, locationName } = req.body;
    if (latitude === undefined || latitude === null || longitude === undefined || longitude === null)
      return res.status(400).json({ message: 'latitude and longitude are required' });

    const lat = Number(latitude);
    const lng = Number(longitude);
    if (Number.isNaN(lat) || Number.isNaN(lng))
      return res.status(400).json({ message: 'latitude and longitude must be numbers' });
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180)
      return res.status(400).json({ message: 'latitude/longitude out of range' });

    const message = await Message.create({
      conversation: conversation._id,
      sender:       req.user.userId,
      readBy:       [req.user.userId],
      messageType:  'location',
      content:      locationName || `${lat}, ${lng}`,
      latitude:     lat,
      longitude:    lng,
      locationName: locationName || null,
    });
    await message.populate('sender', 'fullName profilePhoto');
    conversation.lastMessage = message._id;
    await conversation.save();
    res.status(201).json({ message });
  } catch (error) {
    console.error('Location message error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.patch('/api/conversations/:id/read', authenticate, async (req, res) => {
  try {
    await Message.updateMany(
      { conversation: req.params.id, readBy: { $ne: req.user.userId } },
      { $addToSet: { readBy: req.user.userId } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  HEALTH CHECK & ERROR HANDLING
// ══════════════════════════════════════════════════════════════════════════════

app.get('/health', (_req, res) => {
  res.json({
    status:   'ok',
    mongo:    mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    firebase: admin.apps.length > 0 ? 'initialised' : 'not initialised',
    time:     new Date().toISOString(),
  });
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError)
    return res.status(400).json({ message: `Upload error: ${err.message}` });
  if (err.message && err.message.startsWith('Only '))
    return res.status(400).json({ message: err.message });
  next(err);
});
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed')
    return res.status(400).json({ message: 'Invalid JSON body.' });
  next(err);
});
app.use((req, res) => {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.path}` });
});
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ message: 'Internal server error.' });
});

// ── Start server (local only — Vercel uses module.exports) ────────────────────
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`🚀 Local server running on port ${PORT}`));
}

module.exports = app;
