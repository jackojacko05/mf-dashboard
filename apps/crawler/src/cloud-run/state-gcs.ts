import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { Storage } from "@google-cloud/storage";

const storage = new Storage();

export async function downloadStateFile(
  bucketName: string,
  objectName: string,
  destination: string,
): Promise<boolean> {
  const file = storage.bucket(bucketName).file(objectName);
  const [exists] = await file.exists();
  if (!exists) return false;
  await mkdir(path.dirname(destination), { recursive: true });
  await file.download({ destination });
  return true;
}

export async function uploadStateFile(
  bucketName: string,
  objectName: string,
  source: string,
): Promise<boolean> {
  try {
    await access(source);
  } catch {
    return false;
  }
  await storage.bucket(bucketName).upload(source, {
    destination: objectName,
    metadata: { cacheControl: "no-store" },
    resumable: false,
  });
  return true;
}
