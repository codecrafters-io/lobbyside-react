import type { NextConfig } from "next";

const config: NextConfig = {
  // The example imports @lobbyside/react via file:../.. for local dev.
  // Next.js handles the symlink fine once you've run `npm install` in
  // this directory. If you hit "Cannot find module" or RSC manifest
  // errors when running in-repo, wipe `.next/` and reinstall.
};

export default config;
