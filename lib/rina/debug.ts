export function imageDebug(message: string, ...args: unknown[]): void {
  if (process.env.RINA_IMAGE_DEBUG !== "1") return;
  console.log(message, ...args);
}
