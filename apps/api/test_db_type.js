import mongoose from 'mongoose';
import NotificationLog from './src/models/NotificationLog.js';
import dotenv from 'dotenv';
dotenv.config();

async function test() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27018/notifyflow');
  
  const anyLog = await NotificationLog.findOne({});
  if (!anyLog) { console.log('No logs found'); await mongoose.disconnect(); return; }
  
  const tenantId = anyLog.tenantId; // This is an ObjectId
  const tenantIdStr = tenantId.toString();
  
  console.log('Testing with tenantId:', tenantIdStr);
  
  // Test 1: find()
  const findResult = await NotificationLog.find({ tenantId: tenantIdStr }).limit(1);
  console.log('find() result count:', findResult.length);
  
  // Test 2: aggregate with string (this is what I expect to fail)
  const aggResult1 = await NotificationLog.aggregate([
    { $match: { tenantId: tenantIdStr } },
    { $count: 'count' }
  ]);
  console.log('aggregate(string) count:', aggResult1[0]?.count || 0);
  
  // Test 3: aggregate with ObjectId
  const aggResult2 = await NotificationLog.aggregate([
    { $match: { tenantId: new mongoose.Types.ObjectId(tenantIdStr) } },
    { $count: 'count' }
  ]);
  console.log('aggregate(ObjectId) count:', aggResult2[0]?.count || 0);

  // Test 4: aggregate with the actual ObjectId from the doc
  const aggResult3 = await NotificationLog.aggregate([
    { $match: { tenantId: tenantId } },
    { $count: 'count' }
  ]);
  console.log('aggregate(actual ObjectId) count:', aggResult3[0]?.count || 0);

  await mongoose.disconnect();
}
test();
