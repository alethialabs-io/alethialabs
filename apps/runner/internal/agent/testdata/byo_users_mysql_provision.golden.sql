-- alethia db-bootstrap --byo-users (mysql), provision script. Apply with mysql -N -B, WITHOUT --force: the first error stops the run.
-- Passwords are carried as caching_sha2_password hashes only. The final SELECT is the only one that returns rows.
SET SESSION group_concat_max_len = 1048576;
-- phase 0: refuse a server older than MySQL 8.0.21, before anything changes
SET @alethia_byo_floor = 0 /*!80021 + 1 */;
SET @alethia_byo_s = IF(@alethia_byo_floor = 1, 'DO 0', 'SELECT `per-binding database users need MySQL 8.0.21 or newer`');
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
-- phase 1: lock out every revocation candidate
SET @alethia_byo_s = (SELECT IFNULL(CONCAT('ALTER USER ', GROUP_CONCAT(CONCAT(QUOTE(c.USER), '@', QUOTE(c.HOST)) ORDER BY c.USER SEPARATOR ', '), ' ACCOUNT LOCK'), 'DO 0')
    FROM (SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND CHAR_LENGTH(a.USER) = 24 AND a.HOST = '%'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'
      AND CAST(a.USER AS BINARY) NOT IN ('alethia_byo_0123456789ab')) c);
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
-- phase 2: every declared user; each stays locked until its checks have passed
-- alethia_byo_0123456789ab
CREATE USER IF NOT EXISTS 'alethia_byo_0123456789ab'@'%' IDENTIFIED WITH caching_sha2_password AS '$A$005$BBBBBBBBBBBBBBBBBBBBpkqu8e9Gwp5813a8ikanw8hSCkN.yyCF3gNMmvKmvU3' REQUIRE SSL WITH MAX_USER_CONNECTIONS 20 ACCOUNT LOCK ATTRIBUTE '{"alethia_env":"env-1"}';
SET @alethia_byo_s = IF((SELECT COUNT(*) FROM information_schema.USER_ATTRIBUTES a
    WHERE CAST(a.USER AS BINARY) = 'alethia_byo_0123456789ab' AND a.HOST = '%' AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1') = 1, 'DO 0', 'SELECT `alethia_byo_0123456789ab is not tagged with this environment`');
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
ALTER USER 'alethia_byo_0123456789ab'@'%' IDENTIFIED WITH caching_sha2_password AS '$A$005$BBBBBBBBBBBBBBBBBBBBpkqu8e9Gwp5813a8ikanw8hSCkN.yyCF3gNMmvKmvU3' REQUIRE SSL WITH MAX_USER_CONNECTIONS 20 ACCOUNT LOCK;
CREATE DATABASE IF NOT EXISTS `alethia_byo_0123456789ab`;
SET @alethia_byo_s = CONCAT('GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, REFERENCES ON `', IF(@@partial_revokes, 'alethia_byo_0123456789ab', REPLACE('alethia_byo_0123456789ab', '_', CONCAT(CHAR(92 USING utf8mb4), '_'))), '`.* TO ''alethia_byo_0123456789ab''@''%''');
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
SET @alethia_byo_s = IF((SELECT COUNT(*) FROM (
    SELECT 1 FROM information_schema.USER_PRIVILEGES p
      WHERE p.GRANTEE = '''alethia_byo_0123456789ab''@''%''' AND (p.PRIVILEGE_TYPE <> 'USAGE' OR p.IS_GRANTABLE <> 'NO')
    UNION ALL
    SELECT 1 FROM information_schema.SCHEMA_PRIVILEGES p
      WHERE p.GRANTEE = '''alethia_byo_0123456789ab''@''%'''
        AND (p.TABLE_SCHEMA NOT IN ('alethia_byo_0123456789ab', REPLACE('alethia_byo_0123456789ab', '_', CONCAT(CHAR(92 USING utf8mb4), '_')))
             OR p.PRIVILEGE_TYPE NOT IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'INDEX', 'REFERENCES') OR p.IS_GRANTABLE <> 'NO')
    UNION ALL
    SELECT 1 FROM mysql.role_edges r WHERE CAST(r.TO_USER AS BINARY) = 'alethia_byo_0123456789ab' AND r.TO_HOST = '%') x) = 0, 'DO 0', 'SELECT `alethia_byo_0123456789ab holds a privilege beyond its own`');
PREPARE alethia_byo_s FROM @alethia_byo_s;
EXECUTE alethia_byo_s;
DEALLOCATE PREPARE alethia_byo_s;
ALTER USER 'alethia_byo_0123456789ab'@'%' ACCOUNT UNLOCK;
-- result: the provisioned set, the only rows this script returns
SELECT s.line FROM (
  SELECT 0 AS o, CONCAT('alethia-byo-users v1 count=', COUNT(*)) AS line FROM (SELECT CONVERT(a.USER USING utf8mb4) AS line FROM information_schema.USER_ATTRIBUTES a
      JOIN mysql.user m ON CAST(m.User AS BINARY) = CAST(a.USER AS BINARY) AND CAST(m.Host AS BINARY) = CAST(a.HOST AS BINARY)
      WHERE a.HOST = '%' AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1' AND m.account_locked = 'N'
        AND CAST(a.USER AS BINARY) IN ('alethia_byo_0123456789ab')) r
  UNION ALL
  SELECT 1, r.line FROM (SELECT CONVERT(a.USER USING utf8mb4) AS line FROM information_schema.USER_ATTRIBUTES a
      JOIN mysql.user m ON CAST(m.User AS BINARY) = CAST(a.USER AS BINARY) AND CAST(m.Host AS BINARY) = CAST(a.HOST AS BINARY)
      WHERE a.HOST = '%' AND JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1' AND m.account_locked = 'N'
        AND CAST(a.USER AS BINARY) IN ('alethia_byo_0123456789ab')) r) s
    ORDER BY s.o, s.line;
