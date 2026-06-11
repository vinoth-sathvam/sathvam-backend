-- Migration 027: Add rekognition_face_id to employees for biometric attendance kiosk
-- Run this in Supabase SQL editor before enabling the kiosk feature.

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS rekognition_face_id TEXT DEFAULT NULL;

COMMENT ON COLUMN employees.rekognition_face_id IS
  'AWS Rekognition FaceId — set when admin registers the employee face for kiosk attendance';
