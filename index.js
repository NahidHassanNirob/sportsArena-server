const { MongoClient, ObjectId } = require("mongodb");
const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");

const { jwtVerify, createRemoteJWKSet } = require("jose-cjs");

dotenv.config();

const app = express();
const port = process.env.PORT;

// middleware
app.use(express.json());

// cors({
//   origin: [
//     "https://sports-arena-client.vercel.app",
//     "http://localhost:3000"
//   ],
//   credentials: true,
// })

const allowedOrigins = [
  'https://sports-arena-client.vercel.app',
  'http://localhost:3000'
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'], 
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));


const secret = new TextEncoder().encode(process.env.BETTER_AUTH_SECRET);

// const verifyToken = async (req, res, next) => {
//   const authHeader = req.headers.authorization;
//   const token = authHeader?.split(" ")[1]; 


//   if (!token) {
//     return res.status(401).json({ message: "Unauthorized" });
//   }

//   try {
//     const { payload } = await jwtVerify(token, secret);
//     req.user = payload;
//     next();
//   } catch (error) {
//     return res.status(401).json({ message: "Invalid Token" });
//     console.error("JWT Verification Error:", error.message);
//   }
// };

// MongoDB


// Better Auth এর public JWKS endpointথেকে key নিন
const JWKS = createRemoteJWKSet(
  new URL(`${process.env.CLIENT_URL}/api/auth/jwks`)
);

const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(" ")[1];

  if (!token) return res.status(401).json({ message: "Unauthorized" });

  try {
    const { payload } = await jwtVerify(token, JWKS);
    // console.log("Payload:", payload);
    req.user = payload;
    next();
  } catch (error) {
    // console.error("JWT Error:", error.message);
    return res.status(401).json({ message: "Invalid Token" });
  }
};
const client = new MongoClient(process.env.MONGODB_URI);


const run = async () => {
  try {
    const db = client.db("sportsArena");
    const features = db.collection("featuredfacilities");
    const bookings = db.collection("bookings");

    // =====================
    // PUBLIC ROUTES
    // =====================

    app.get("/featuredfacilities", async (req, res) => {
      const data = await features.find().limit(6).toArray();
      res.send(data);
    });

    app.get("/facilities", async (req, res) => {
      const { search, filter } = req.query;

      let query = {};

      if (filter && filter !== "All") {
        query.facilityType = { $regex: filter, $options: "i" };
      }

      if (search) {
        query.$or = [
          { facilityName: { $regex: search, $options: "i" } },
          { location: { $regex: search, $options: "i" } },
        ];
      }

      const data = await features.find(query).toArray();
      res.send(data);
    });

    app.get("/facilities/:id", async (req, res) => {
      const data = await features.findOne({
        _id: new ObjectId(req.params.id),
      });
      res.send(data);
    });

    // =====================
    // PROTECTED ROUTES
    // =====================

    app.post("/facilities", verifyToken, async (req, res) => {
      const result = await features.insertOne({
        ...req.body,
        ownerEmail: req.user.email,
      });

      res.send(result);
    });

    app.post("/bookings", verifyToken, async (req, res) => {
      try {
        const { facilityId, totalHours } = req.body;

        const facility = await features.findOne({
          _id: new ObjectId(facilityId),
        });

        if (!facility) {
          return res.status(404).json({ message: "Not found" });
        }

        const currentSlots = parseInt(facility.availableSlot) || 0;

        if (currentSlots < totalHours) {
          return res.status(400).json({ message: "No slots available" });
        }

        const booking = {
          ...req.body,
          facilityId: new ObjectId(facilityId),
          userEmail: req.user.email,
        };

        await bookings.insertOne(booking);

        await features.updateOne(
          { _id: new ObjectId(facilityId) },
          {
            $set: {
              availableSlot: String(currentSlots - totalHours),
            },
          }
        );

        res.status(200).json({ acknowledged: true });
      } catch (err) {
        res.status(500).json({ message: "Server Error" });
      }
    });

    app.get("/bookings", verifyToken, async (req, res) => {
      const data = await bookings
        .find({ userEmail: req.user.email })
        .toArray();

      res.send(data);
    });

    app.get("/ownerfacilities", verifyToken, async (req, res) => {
      const data = await features
        .find({ ownerEmail: req.user.email })
        .toArray();

      res.send(data);
    });

    app.patch("/facilities/:id", verifyToken, async (req, res) => {
      const result = await features.updateOne(
        {
          _id: new ObjectId(req.params.id),
          ownerEmail: req.user.email,
        },
        { $set: req.body }
      );

      res.send(result);
    });

    app.delete("/facilities/:id", verifyToken, async (req, res) => {
      const result = await features.deleteOne({
        _id: new ObjectId(req.params.id),
        ownerEmail: req.user.email,
      });

      res.send(result);
    });

    app.delete("/bookings/:id", verifyToken, async (req, res) => {
  try {
    const booking = await bookings.findOne({
      _id: new ObjectId(req.params.id),
      userEmail: req.user.email,
    });

    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    // ✅ facility null হলেও crash করবে না
    const facility = await features.findOne({
      _id: new ObjectId(booking.facilityId),
    });

    if (facility) {
      await features.updateOne(
        { _id: new ObjectId(booking.facilityId) },
        {
          $set: {
            availableSlot: String(
              (parseInt(facility.availableSlot) || 0) + (booking.totalHours || 0)
            ),
          },
        }
      );
    }

    await bookings.deleteOne({ _id: new ObjectId(req.params.id) });

    res.json({ acknowledged: true });

  } catch (err) {
    // console.error("Delete booking error:", err.message);
    res.status(500).json({ message: "Server Error", error: err.message });
  }
});
  } catch (err) {
    // console.error("DB Error:", err);
  }
};

run();

// root route
app.get("/", (req, res) => {
  res.send("Sports Arena Server Running");
});

// start server
app.listen(port, () => {
  console.log(`Server running on ${port}`);
});