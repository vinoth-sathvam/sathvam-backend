const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const s3 = new S3Client({
  region: process.env.AWS_REGION || 'ap-south-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.S3_BUCKET || 'sathvam-storage';
const CDN_URL = process.env.S3_CDN_URL || `https://${BUCKET}.s3.${process.env.AWS_REGION || 'ap-south-1'}.amazonaws.com`;

async function uploadFile(folder, fileName, buffer, contentType) {
  const key = `${folder}/${fileName}`;
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));
  return `${CDN_URL}/${key}`;
}

async function deleteFile(folder, fileName) {
  const key = `${folder}/${fileName}`;
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

function getPublicUrl(folder, fileName) {
  return `${CDN_URL}/${folder}/${fileName}`;
}

module.exports = { uploadFile, deleteFile, getPublicUrl, s3, BUCKET, CDN_URL };
