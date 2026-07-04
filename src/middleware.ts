export { default } from "next-auth/middleware";

// Everything requires a session except auth pages and NextAuth's own routes.
export const config = {
  matcher: [
    "/((?!login|register|api/auth|_next/static|_next/image|favicon.ico).*)",
  ],
};
