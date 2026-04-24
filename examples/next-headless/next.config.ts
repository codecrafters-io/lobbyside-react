import type { NextConfig } from "next";

const config: NextConfig = {
  // @lobbyside/react ships as ESM + CJS with its own types. Nothing
  // special needed — Next's default bundler handles workspace deps.
};

export default config;
