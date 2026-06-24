require('dotenv').config();

const express    = require('express');
const mongoose   = require('mongoose');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const cors       = require('cors');
const multer     = require('multer');
const path       = require('path');
const cloudinary = require('cloudinary').v2;

const app = express();

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Check JWT secret ───────────────────────────────────────────────────────────
if (!process.env.JWT_SECRET) {
  console.error('❌  JWT_SECRET is not defined in .env file');
  process.exit(1);
}

// ── Cloudinary configuration ───────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── Multer – memory storage ────────────────────────────────────────────────────
const memoryStorage = multer.memoryStorage();

// For profile photos (images only, 5 MB) – used in register AND update
const upload = multer({
  storage:    memoryStorage,
  limits:     { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const isImage = /\.(jpe?g|png|gif|webp)$/i.test(file.originalname);
    isImage ? cb(null, true) : cb(new Error('Only image files (jpg, png, gif, webp) are allowed.'));
  },
});

// For application documents (PDF, images, 10 MB)
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

// For chat attachments sent through our own server (small files / legacy path).
const uploadChatFile = multer({
  storage:    memoryStorage,
  limits:     { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, _file, cb) => cb(null, true),
}).single('file');

// For qualification documents (PDF or images, 10 MB)
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

// For portfolio images (multiple, images only, 5 MB each)
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
    .connect(MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
    })
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

    // Profile setup fields
    location:    { type: String, default: '' },
    coordinates: {
      latitude:  { type: Number, default: null },
      longitude: { type: Number, default: null },
    },
    qualifications:   [qualificationSchema],
    portfolioImages:  [portfolioImageSchema],
    verificationSettings: {
      expiryReminder:    { type: Boolean, default: true },
      emailReminders:    { type: Boolean, default: true },
      pushNotifications: { type: Boolean, default: false },
      remindDaysBefore:  { type: Number,  default: 15 },
    },
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
    documents:   [{
      originalName: String,
      url:          String,
      publicId:     String,
    }],
  },
  { timestamps: true }
);

const Application = mongoose.model('Application', applicationSchema);

// ── Conversation & Message Schemas (Chat) ─────────────────────────────────────
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

// ── Helper: upload buffer to Cloudinary ───────────────────────────────────────
const uploadToCloudinary = (buffer, folder, resource_type = 'auto') =>
  new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder, resource_type },
      (error, result) => (error ? reject(error) : resolve(result))
    );
    uploadStream.end(buffer);
  });

// ── Helper: determine message type from MIME ──────────────────────────────────
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

// ── NEW: Onboarding auth – allows userId in body if no token present ──────────
const onboardingAuth = async (req, res, next) => {
  // Already authenticated via JWT → skip
  if (req.user) return next();

  // 1. Try userId from body (works for JSON requests)
  // 2. If not found, try the X-User-Id header (for multipart requests)
  const userId = req.body.userId || req.headers['x-user-id'];
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
// Helper: is this user actually a participant of this conversation?
const isParticipant = (conversation, userId) =>
  conversation.participants.map(String).includes(String(userId));

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

    // ⚠️ NO token generated here – only return userId
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

// ── NEW: Complete registration – issue the final token after verification ─────
app.post('/api/register/complete', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ message: 'userId is required.' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    const token = jwt.sign(
      { userId: user._id, email: user.email, role: user.role },
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
      { userId: user._id, email: user.email, role: user.role },
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

app.get('/api/profile', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ message: 'User not found.' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  PROFILE SETUP ROUTES (modified to accept userId during onboarding)
// ══════════════════════════════════════════════════════════════════════════════

// PUT /api/profile/location
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

// POST /api/profile/qualifications
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
        const result     = await uploadToCloudinary(req.file.buffer, 'qualifications');
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

// DELETE /api/profile/qualifications/:qualId
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

// POST /api/profile/portfolio
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

// DELETE /api/profile/portfolio/:imageId
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

// PUT /api/profile/verification
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

// PUT /api/profile (update basic fields + photo) – JWT required
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
    if (bio !== undefined)   update.bio   = bio;

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

    const totalPages = Math.ceil(totalCount / limit);

    res.json({
      jobs,
      currentPage: page,
      totalPages,
      totalCount,
      hasMore: page < totalPages,
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
      description, requirements, schedule, rate, distance, maxClients, coverTime,
    } = req.body;

    if (!title || !company || !location || !salary || !jobType)
      return res.status(400).json({ message: 'Missing required fields.' });

    const job = await Job.create({
      title, company, location, salary, jobType, workingPlaceType,
      description, requirements, schedule, rate, distance, maxClients, coverTime,
      postedBy: req.user.userId,
    });
    res.status(201).json({ message: 'Job posted successfully', job });
  } catch (err) {
    console.error('Job creation error:', err);
    if (err.name === 'ValidationError') {
      const messages = Object.values(err.errors).map(e => e.message);
      return res.status(400).json({ message: messages.join(' | ') });
    }
    res.status(500).json({ message: 'Server error. Please try again.' });
  }
});

app.post('/api/jobs/:id/apply', authenticate, (req, res) => {
  uploadAppDocs(req, res, async (err) => {
    if (err) return res.status(400).json({ message: err.message });
    try {
      const job = await Job.findById(req.params.id);
      if (!job) return res.status(404).json({ message: 'Job not found.' });

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

      console.log(`📨  New application for "${job.title}" by ${email}`);
      res.status(201).json({ message: 'Application submitted successfully.', application });
    } catch (error) {
      console.error('Apply error:', error);
      res.status(500).json({ message: 'Server error. Please try again.' });
    }
  });
});

app.get('/api/applications/me', authenticate, async (req, res) => {
  try {
    const applications = await Application.find({ applicant: req.user.userId })
      .populate('job')
      .sort({ createdAt: -1 });
    res.json({ count: applications.length, applications });
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

// ── TEMPORARY CONTACT LIST (unchanged)
app.get('/api/contacts', authenticate, async (req, res) => {
  try {
    const currentUser = await User.findById(req.user.userId);
    if (!currentUser) return res.status(404).json({ message: 'User not found' });

    const oppositeRole = currentUser.role === 'Practitioner' ? 'Business' : 'Practitioner';

    const contacts = await User.find({ role: oppositeRole })
      .select('fullName profilePhoto role')
      .sort({ fullName: 1 });

    res.json({ contacts });
  } catch (err) {
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
          _id:           conv._id,
          otherUser:     otherParticipant,
          lastMessage:   conv.lastMessage,
          unreadCount,
          updatedAt:     conv.updatedAt,
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
        const result            = await uploadToCloudinary(req.file.buffer, 'chat_files', 'auto');
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
      fileName:     fileName  || null,
      fileSize:     fileSize  || null,
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
    const conversationId = req.params.id;
    const userId         = req.user.userId;
    await Message.updateMany(
      { conversation: conversationId, readBy: { $ne: userId } },
      { $addToSet: { readBy: userId } }
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
    status: 'ok',
    mongo:  mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    time:   new Date().toISOString(),
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

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`🚀 Local server running on port ${PORT}`));
}

module.exports = app;
