require('dotenv').config(); // still useful locally, but on Vercel use env vars

const express    = require('express');
const mongoose   = require('mongoose');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const cors       = require('cors');
const multer     = require('multer');
const path       = require('path');
const cloudinary = require('cloudinary').v2;

const app = express();

// ── Basic Middleware ───────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Check JWT secret ───────────────────────────────────────────────────────────
if (!process.env.JWT_SECRET) {
  console.error('❌  JWT_SECRET is not defined');
  process.exit(1);
}

// ── Cloudinary configuration ───────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── Multer – memory storage (no disk writes) ───────────────────────────────────
const memoryStorage = multer.memoryStorage();

const upload = multer({
  storage: memoryStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    const isImage = /\.(jpe?g|png|gif|webp)$/i.test(file.originalname);
    isImage ? cb(null, true) : cb(new Error('Only image files (jpg, png, gif, webp) are allowed.'));
  },
});

const uploadAppDocs = multer({
  storage: memoryStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const allowed = /\.(pdf|jpe?g|png|gif|webp)$/i;
    allowed.test(path.extname(file.originalname))
      ? cb(null, true)
      : cb(new Error('Only PDF and image files are allowed.'));
  },
}).array('documents', 5);

// ── MongoDB connection setup ───────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('❌ MONGO_URI is not set');
  process.exit(1);
}

let cachedDb = null;

async function connectToDatabase() {
  // Re-use existing connection if healthy
  if (cachedDb && mongoose.connection.readyState === 1) {
    return cachedDb;
  }
  await mongoose.connect(MONGO_URI, {
    serverSelectionTimeoutMS: 10000, // fail fast on cold start issues
  });
  cachedDb = mongoose.connection;
  console.log('✅ MongoDB connected');
  return cachedDb;
}

// ── DB connection middleware ─────────────────────────────────────────────
// ✅ CRITICAL: This must be registered BEFORE any routes so every
//    request waits for the DB to be ready (important for Vercel cold starts).
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
const userSchema = new mongoose.Schema(
  {
    fullName:     { type: String, required: true, trim: true },
    email:        { type: String, required: true, unique: true, lowercase: true, trim: true,
                    match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email'] },
    phone:        { type: String, required: true, trim: true },
    password:     { type: String, required: true },
    bio:          { type: String, default: '', trim: true },
    role:         { type: String, enum: ['Practitioner', 'Business'], default: 'Practitioner' },
    profilePhoto: { type: String, default: null },
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
    job:         { type: mongoose.Schema.Types.ObjectId, ref: 'Job', required: true },
    applicant:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    fullName:    { type: String, required: true },
    email:       { type: String, required: true },
    phone:       { type: String, required: true },
    coverLetter: { type: String, default: '' },
    documents:   [{
      originalName: String,
      url:          String,  // Cloudinary secure URL
      publicId:     String,  // for management/deletion
    }],
  },
  { timestamps: true }
);

const Application = mongoose.model('Application', applicationSchema);

// ── Helper: upload buffer to Cloudinary ───────────────────────────────────────
const uploadToCloudinary = (buffer, folder, resource_type = 'auto') => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type },
      (error, result) => (error ? reject(error) : resolve(result))
    );
    stream.end(buffer);
  });
};

// ── Authentication middleware ──────────────────────────────────────────────────
const authenticate = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'No token provided.' });
    }
    const token = authHeader.split(' ')[1];
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ message: 'Invalid or expired token.' });
  }
};

// ══════════════════════════════════════════════════════════════════════════════
//  ROUTES  (all defined after the DB middleware above)
// ══════════════════════════════════════════════════════════════════════════════

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    mongo:  mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    time:   new Date().toISOString(),
  });
});

// ── POST /api/register ─────────────────────────────────────────────────────────
app.post('/api/register', upload.single('profilePhoto'), async (req, res) => {
  try {
    const { fullName, email, phone, password, bio, role } = req.body;

    if (!fullName || !email || !phone || !password) {
      return res.status(400).json({ message: 'fullName, email, phone, and password are all required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters.' });
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(409).json({ message: 'An account with this email already exists.' });

    let profilePhotoUrl = null;
    if (req.file) {
      const result = await uploadToCloudinary(req.file.buffer, 'profile_photos', 'image');
      profilePhotoUrl = result.secure_url;
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const user = await User.create({
      fullName,
      email,
      phone,
      password: hashedPassword,
      bio: bio || '',
      role: role || 'Practitioner',
      profilePhoto: profilePhotoUrl,
    });

    const token = jwt.sign(
      { userId: user._id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log(`👤  New user → ${user._id} (${user.email})`);
    return res.status(201).json({ message: 'Profile created successfully.', token, userId: user._id, user });
  } catch (err) {
    console.error('Register error:', err.message);
    if (err.code === 11000) return res.status(409).json({ message: 'Email already in use.' });
    if (err.name === 'ValidationError') {
      return res.status(400).json({ message: Object.values(err.errors).map(e => e.message).join(' | ') });
    }
    return res.status(500).json({ message: 'Server error. Please try again.' });
  }
});

// ── POST /api/login ────────────────────────────────────────────────────────────
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
    res.json({ message: 'Login successful', token, user: user.toJSON() });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'Server error. Please try again.' });
  }
});

// ── GET /api/profile (protected) ──────────────────────────────────────────────
app.get('/api/profile', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ message: 'User not found.' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── GET /api/jobs ──────────────────────────────────────────────────────────────
app.get('/api/jobs', async (_req, res) => {
  try {
    const jobs = await Job.find().sort({ createdAt: -1 }).populate('postedBy', 'fullName email');
    res.json({ count: jobs.length, jobs });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── GET /api/jobs/:id ──────────────────────────────────────────────────────────
app.get('/api/jobs/:id', async (req, res) => {
  try {
    const job = await Job.findById(req.params.id).populate('postedBy', 'fullName email');
    if (!job) return res.status(404).json({ message: 'Job not found.' });
    res.json(job);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── POST /api/jobs ─────────────────────────────────────────────────────────────
app.post('/api/jobs', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'Business') {
      return res.status(403).json({ message: 'Only Business accounts can post jobs.' });
    }
    const { title, company, location, salary, jobType, workingPlaceType,
            description, requirements, schedule, rate, distance, maxClients, coverTime } = req.body;

    if (!title || !company || !location || !salary || !jobType) {
      return res.status(400).json({ message: 'Missing required fields.' });
    }

    const job = await Job.create({
      title, company, location, salary, jobType, workingPlaceType,
      description, requirements, schedule, rate, distance, maxClients, coverTime,
      postedBy: req.user.userId,
    });
    res.status(201).json({ message: 'Job posted successfully', job });
  } catch (err) {
    console.error('Job creation error:', err);
    if (err.name === 'ValidationError') {
      return res.status(400).json({ message: Object.values(err.errors).map(e => e.message).join(' | ') });
    }
    res.status(500).json({ message: 'Server error. Please try again.' });
  }
});

// ── POST /api/jobs/:id/apply ───────────────────────────────────────────────────
app.post('/api/jobs/:id/apply', authenticate, (req, res) => {
  uploadAppDocs(req, res, async (err) => {
    if (err) return res.status(400).json({ message: err.message });

    try {
      const job = await Job.findById(req.params.id);
      if (!job) return res.status(404).json({ message: 'Job not found.' });

      const { fullName, email, phone, coverLetter } = req.body;
      if (!fullName || !email || !phone) {
        return res.status(400).json({ message: 'fullName, email, and phone are required.' });
      }

      const documents = [];
      if (req.files?.length) {
        for (const file of req.files) {
          const result = await uploadToCloudinary(file.buffer, 'application_documents');
          documents.push({ originalName: file.originalname, url: result.secure_url, publicId: result.public_id });
        }
      }

      const application = await Application.create({
        job: job._id,
        applicant: req.user.userId,
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

// ── GET /api/applications/me ───────────────────────────────────────────────────
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

// ── GET /api/users ─────────────────────────────────────────────────────────────
app.get('/api/users', async (_req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 });
    res.json({ count: users.length, users });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── GET /api/users/:id ─────────────────────────────────────────────────────────
app.get('/api/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found.' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Error Handlers ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ message: `Upload error: ${err.message}` });
  if (err.message?.startsWith('Only '))  return res.status(400).json({ message: err.message });
  next(err);
});
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ message: 'Invalid JSON body.' });
  next(err);
});
app.use((req, res) => {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.path}` });
});
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ message: 'Internal server error.' });
});

// ── Local dev server ───────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  connectToDatabase().then(() => {
    app.listen(PORT, () => console.log(`🚀 Local server on port ${PORT}`));
  });
}

module.exports = app; // Vercel expects the Express app exported
