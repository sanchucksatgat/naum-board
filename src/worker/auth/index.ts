/** 태스크1 공개 API: 다른 태스크는 여기서 가져다 쓴다. */
export { requireTeacher, getTeacher, teacherOnly, type TeacherSession, type TeacherVariables, SESSION_COOKIE } from "./session";
export { signToken, verifyToken, randomToken, base64UrlEncode, base64UrlDecode, timingSafeEqualStr, type TokenClaims } from "./token";
export { getSigningSecret } from "./secret";
export { getGoogleAccessToken, invalidateGoogleAccessToken, GoogleAccessError, type GoogleAccessFailure } from "./access";
export { getCookie, serializeCookie, clearCookie } from "./cookies";
export { authRoutes } from "./routes";
