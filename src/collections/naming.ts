/**
 * Collection naming strategy
 */

import { basename } from "path";

/**
 * Generate collection name from directory path
 *
 * Strategies:
 * 1. Use directory basename by default
 * 2. Sanitize invalid characters
 * 3. Handle duplicates with numbering
 */
export function directoryToCollectionName(
  directoryPath: string,
  existingNames: Set<string> = new Set()
): string {
  // Get the base name of the directory
  let name = basename(directoryPath);

  // Sanitize: remove or replace invalid characters
  // Ente allows most characters, but we'll be conservative
  name = sanitizeName(name);

  // Handle empty names (e.g., root directory)
  if (!name || name.length === 0) {
    name = "Untitled";
  }

  // Handle duplicates by appending a number
  let finalName = name;
  let counter = 2;
  while (existingNames.has(finalName)) {
    finalName = `${name} (${counter})`;
    counter++;
  }

  return finalName;
}

/**
 * Generate hierarchical collection name preserving path structure
 * Example: /photos/2024/vacation -> "photos/2024/vacation"
 */
export function directoryToHierarchicalName(
  directoryPath: string,
  rootPath: string
): string {
  // Get relative path from root
  const relativePath = directoryPath.startsWith(rootPath)
    ? directoryPath.slice(rootPath.length)
    : directoryPath;

  // Remove leading/trailing slashes
  let name = relativePath.replace(/^\/+|\/+$/g, "");

  // Replace remaining slashes with separator
  name = name.replace(/\//g, " / ");

  return sanitizeName(name) || "Untitled";
}

/**
 * Sanitize collection name
 */
function sanitizeName(name: string): string {
  // Replace problematic characters
  return (
    name
      // Remove leading/trailing dots and spaces
      .replace(/^[.\s]+|[.\s]+$/g, "")
      // Replace multiple spaces with single space
      .replace(/\s+/g, " ")
      // Remove control characters
      .replace(/[\x00-\x1F\x7F]/g, "")
      // Replace other problematic characters
      .replace(/[<>:"|?*]/g, "_")
      // Limit length
      .slice(0, 255)
  );
}

/**
 * Extract potential parent collection from path
 * Example: /photos/2024/vacation -> ["photos", "photos/2024"]
 */
export function extractPathComponents(directoryPath: string): string[] {
  const parts = directoryPath.split("/").filter((p) => p.length > 0);
  const components: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    const component = parts.slice(0, i + 1).join("/");
    components.push(component);
  }

  return components;
}
