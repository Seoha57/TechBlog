---
layout: post
title: "PostgreSQL 18 OAuth 인증을 설계하는 법: 토큰·역할·Validator·접속 운영"
date: 2026-09-23 08:30:00 +0900
categories: [dba]
tags: [dba, postgresql, postgresql18, oauth, oidc, authentication, security]
description: "PostgreSQL 18의 OAuth 인증을 처음 접하는 사람을 위해 OAuth·OIDC·SASL·role·validator와 단계적 도입 기준을 설명합니다."
---

데이터베이스 계정과 비밀번호를 애플리케이션 설정 파일에 두는 방식은 이해하기 쉽습니다. 하지만 사람이 많아지고 서비스가 늘면 비밀번호 회전, 퇴사자 권한 회수, 여러 시스템의 계정 동기화, 감사 기록이 서로 다른 방식으로 흩어집니다. 이미 회사가 OAuth 2.0 또는 OpenID Connect(OIDC) 기반의 중앙 로그인 체계를 갖고 있다면, 데이터베이스 접속도 같은 정체성 체계와 연결하고 싶어집니다.

PostgreSQL 18은 `pg_hba.conf`의 `oauth` 인증 방법과 libpq OAuth 지원을 추가했습니다. 이는 PostgreSQL이 갑자기 OAuth 서버가 되었다는 뜻이 아닙니다. PostgreSQL은 외부 권한 부여 서버가 발급한 bearer token을 받아, validator 모듈을 통해 검증하고 데이터베이스 role로 연결하는 자원 서버(resource server)에 가깝습니다. 기존 비밀번호를 모두 없애는 기능도, 각 조직의 IdP(Identity Provider)를 자동으로 연결해 주는 버튼도 아닙니다.

이 글은 PostgreSQL 18 공식 문서를 바탕으로 인증 흐름과 운영 판단 기준을 설명합니다. 특정 IdP나 운영 환경에서 직접 검증한 결과를 일반화하지 않습니다. 특히 bearer token은 가진 사람을 인증된 주체로 취급하는 민감한 자격 증명이므로, 실습을 이유로 운영 토큰을 로그·채팅·스크린샷에 넣어서는 안 됩니다.

<section class="quick-answers">
  <p class="quick-label">먼저 답하면</p>
  <div class="quick-answer"><h3>Q. PostgreSQL 18만 설치하면 OAuth 로그인이 바로 되나요?</h3><p>A. 아닙니다. 신뢰할 수 있는 authorization server, HTTPS issuer, 클라이언트 설정, 그리고 서버 쪽 bearer token validator가 필요합니다. PostgreSQL에는 기본 validator 구현이 포함되어 있지 않습니다.</p></div>
  <div class="quick-answer"><h3>Q. OAuth를 쓰면 데이터베이스 권한 관리가 사라지나요?</h3><p>A. 아닙니다. OAuth는 주로 누가 접속하는지를 증명합니다. 어떤 데이터베이스·스키마·테이블을 읽거나 수정할 수 있는지는 여전히 PostgreSQL role, GRANT, RLS(Row-Level Security) 같은 권한 모델로 관리합니다.</p></div>
  <div class="quick-answer"><h3>Q. 모든 애플리케이션 연결에 사람의 OAuth 토큰을 써야 하나요?</h3><p>A. 아닙니다. 사람의 대화형 psql 접속과 서버 간 connection pool은 요구가 다릅니다. 장기 서비스 계정, 비밀 관리, mTLS, SCRAM이 더 맞는 경로도 있으므로 연결 주체별로 설계해야 합니다.</p></div>
</section>

<figure class="article-figure">
  <img src="{{ '/assets/images/postgresql-oauth-connection.svg' | relative_url }}" alt="psql 또는 애플리케이션이 OAuth 권한 부여 서버에서 토큰을 받은 후 PostgreSQL validator를 거쳐 database role로 연결되는 흐름">
  <figcaption>이미지 출처: PostgreSQL 18 OAuth 인증과 libpq OAuth 문서를 바탕으로 직접 제작</figcaption>
</figure>

## 먼저 알아둘 기반 기술: 인증, 인가, OAuth, OIDC, role

**인증(authentication)** 은 “누구인가”를 확인하는 과정입니다. 비밀번호, 클라이언트 인증서, Kerberos 티켓, OAuth access token은 각기 다른 방식으로 이 질문에 답합니다. **인가(authorization)** 는 “그 주체가 무엇을 해도 되는가”를 결정합니다. 데이터베이스에서는 `GRANT SELECT ON orders TO analyst`처럼 role에 권한을 부여하는 일이 인가에 가깝습니다. 로그인에 성공했다고 모든 테이블을 읽을 수 있는 것은 아닙니다.

**OAuth 2.0**은 사용자가 자신의 비밀번호를 다른 애플리케이션에 주지 않고도, 제한된 권한을 가진 access token을 발급받아 보호된 자원에 접근하게 하는 권한 부여 프레임워크입니다. 여기서 자원 소유자(resource owner)는 보통 사용자이고, client는 토큰을 사용하려는 프로그램이며, authorization server는 로그인·동의 뒤 토큰을 발급하는 시스템입니다. PostgreSQL 18 OAuth 문서의 관점에서는 `psql`과 libpq 기반 프로그램이 client, PostgreSQL 클러스터가 resource server가 됩니다.

**OIDC(OpenID Connect)** 는 OAuth 2.0 위에 사용자 정체성 정보를 표현하는 규약을 더한 계열입니다. OAuth와 OIDC는 함께 쓰이는 일이 많지만 완전히 같은 단어는 아닙니다. PostgreSQL의 OAuth 구현은 OIDC discovery 규칙과 상호 운용될 수 있으나, PostgreSQL 자체가 OIDC client여야만 하는 것은 아닙니다. 중요한 것은 IdP가 어떤 issuer를 신뢰의 기준으로 제공하고, 어떤 scope와 claim으로 사용자·권한을 표현하는지입니다.

**bearer token**은 말 그대로 토큰을 가진 사람이 권한을 행사할 수 있는 토큰입니다. 데이터베이스 비밀번호처럼 해시만 저장해 비교하는 비밀과 달리, 유출된 bearer token은 유효 기간과 scope 안에서 바로 사용될 수 있습니다. 토큰이 JWT(JSON Web Token)처럼 읽을 수 있는 형식이라고 해서 서명·issuer·audience·만료 시간을 확인하지 않아도 되는 것은 아닙니다. 반대로 opaque token처럼 내용을 읽을 수 없는 형식도 있을 수 있습니다. PostgreSQL 문서도 access token의 형식은 authorization server 구현에 따라 다르다고 설명합니다.

PostgreSQL의 **role**은 로그인 역할뿐 아니라 권한을 묶는 단위입니다. 사람별 로그인 role에 직접 모든 권한을 주기보다 `report_reader`, `billing_writer` 같은 권한 role을 만들고 사용자 role에 멤버십을 부여할 수 있습니다. OAuth identity가 `alice@example.com`이라고 해도 database role 이름은 `alice`일 수 있으므로, 두 이름을 어떻게 연결하는지가 설계 대상입니다. 토큰을 검증하는 것과 적절한 DB role을 선택하는 것은 별개의 단계입니다.

## PostgreSQL 18에서 달라진 점

PostgreSQL은 오래전부터 SCRAM-SHA-256 비밀번호, TLS client certificate, LDAP, GSSAPI/Kerberos 같은 다양한 인증 방식을 지원했습니다. PostgreSQL 18에서는 `pg_hba.conf`에 `oauth` 인증 방법이 추가됐고, 프런트엔드/백엔드 프로토콜의 SASL(Simple Authentication and Security Layer) 교환에서 `OAUTHBEARER` 메커니즘을 사용할 수 있게 됐습니다. libpq에는 OAuth issuer·client ID 설정과 선택적 Device Authorization 흐름 지원이 들어왔습니다.

이 변화가 유용한 이유는 중앙 IdP가 이미 관리하는 사용자 수명 주기를 데이터베이스 접속과 더 가깝게 맞출 수 있기 때문입니다. 조직 계정이 비활성화되거나 특정 그룹에서 빠졌을 때, 별도의 DB 비밀번호 목록을 나중에 정리하는 대신 토큰 발급과 검증 정책에 반영할 여지가 생깁니다. 다만 중앙화가 자동으로 최소 권한을 만들어 주지는 않습니다. IdP에서 토큰을 발급받을 수 있다는 사실이 운영 DB의 고권한 role을 가질 자격을 뜻해서는 안 됩니다.

또한 PostgreSQL 18은 **인증을 위한 기반**을 제공합니다. 서버는 `oauth_validator_libraries`에 등록된 validator 모듈로 토큰을 검증합니다. 공식 문서에 따르면 PostgreSQL은 서로 다른 OAuth 구현의 token validation을 일반적으로 대신할 수 없으므로, 기본 validator는 제공하지 않습니다. 따라서 “`pg_hba.conf` 한 줄이면 Azure AD, Keycloak, Okta와 연결된다”는 기대는 위험합니다. 공급자와 토큰 형식, audience, claim 매핑, 키 회전, 네트워크 실패를 다루는 통합 구성 요소가 필요합니다.

## 연결이 성립하는 흐름

대화형 `psql` 사용자가 OAuth 접속을 시도한다고 가정해 보겠습니다. 먼저 클라이언트는 PostgreSQL에 연결합니다. 서버가 OAuth SASL 메커니즘을 제시하면, 클라이언트는 이미 가진 access token이 있는지 확인합니다. 없다면 첫 연결은 discovery 정보를 얻기 위한 흐름으로 끝날 수 있습니다. PostgreSQL 18 libpq의 기본 Device Authorization 흐름은 브라우저가 없는 SSH 환경에서도 URL과 사용자 코드를 보여 주고, 사용자가 다른 브라우저에서 인증·동의하도록 할 수 있습니다.

권한 부여 서버는 인증된 사용자에게 access token을 발급합니다. 클라이언트는 새 PostgreSQL 연결에서 token을 `OAUTHBEARER` 방식으로 보냅니다. PostgreSQL 서버의 validator는 서명 또는 introspection 결과, issuer, audience, expiry, 필요한 scope와 사용자 identity를 검증합니다. 검증 결과는 HBA 규칙과 user mapping을 거쳐 요청한 database role과 연결됩니다. 그 뒤에야 일반적인 PostgreSQL 권한 검사가 시작됩니다.

이 과정을 그림으로 보면 단순하지만, 실패 지점은 많습니다. issuer URL의 대소문자·끝 슬래시·discovery 문서의 issuer 값이 완전히 일치하지 않으면 실패할 수 있습니다. 서버가 기대하는 scope와 client가 요청한 scope가 다를 수 있습니다. 토큰이 만료되었거나 audience가 다른 API를 향할 수 있습니다. role mapping이 없거나, 연결은 됐지만 필요한 schema 권한이 없을 수도 있습니다. “OAuth 접속 실패”라는 하나의 오류를 토큰 발급·전송·검증·role 인가 중 어느 단계인지 나누어 조사해야 합니다.

## `pg_hba.conf`와 validator의 역할 분리

`pg_hba.conf`는 어떤 클라이언트가 어떤 database와 user로 어느 인증 방식을 사용할 수 있는지 정하는 PostgreSQL 접근 규칙 파일입니다. 다음은 방향만 보여 주는 예시입니다. 실제 issuer·scope·validator 이름과 네트워크 범위는 조직의 IdP와 운영 표준에 맞춰야 합니다.

```conf
# TYPE  DATABASE  USER       ADDRESS         METHOD  OPTIONS
hostssl analytics analyst    10.20.0.0/16    oauth   issuer="https://id.example.com" scope="postgres.read" validator="company_oauth"
```

`hostssl`은 TLS로 보호된 TCP 연결만 이 규칙에 맞게 한다는 뜻입니다. bearer token을 사용한다고 TLS가 선택 사항이 되는 것은 아닙니다. TLS가 없으면 토큰을 네트워크에서 탈취당할 수 있습니다. `DATABASE`와 `USER`, `ADDRESS`를 넓게 `all`로 열어 두면 처음에는 편해 보여도 인증 경계가 흐려집니다. 읽기 전용 분석 환경의 특정 CIDR과 role처럼 가능한 한 좁게 시작하는 편이 안전합니다.

`issuer`는 authorization server의 신뢰 기준입니다. PostgreSQL은 issuer로부터 discovery URL을 만들거나 well-known URL을 직접 사용할 수 있습니다. 신뢰하지 않는 URL을 issuer로 허용하면, 공격자가 사용자에게 엉뚱한 권한 동의를 요청하거나 토큰을 가로챌 위험이 생깁니다. PostgreSQL 문서도 issuer 운영자를 데이터베이스 서버를 가장할 수 있는 주체처럼 신중히 신뢰하라고 경고합니다.

`validator`는 토큰을 실제로 검증하는 서버 쪽 모듈을 가리킵니다. validator는 단순히 JWT를 base64로 풀어 `sub` claim을 읽는 코드가 되어서는 안 됩니다. 최소한 token의 무결성, issuer, 만료, audience, 필요한 scope, 인증된 identity를 검증해야 합니다. IdP의 공개 키(JWKS) 회전이나 token introspection 호출 실패를 어떻게 처리할지도 포함됩니다. 검증에 실패했을 때 “일시적 네트워크 장애”와 “권한 없는 토큰”을 같은 방식으로 무조건 허용하면 안 됩니다.

## identity를 PostgreSQL role에 연결하기

토큰 검증이 성공한 뒤에도 토큰 속의 identity와 PostgreSQL role 사이를 연결해야 합니다. 가장 단순한 방식은 IdP identity와 database role 이름을 똑같이 만드는 것입니다. 예를 들어 `jiyun`이라는 사람이 `jiyun` role로 접속합니다. 시작은 쉽지만 이메일 변경, 이름 중복, 서비스 계정, 외부 협력사 계정을 처리하기 어려울 수 있습니다.

다른 방식은 `pg_ident.conf`의 user map 또는 validator가 제공하는 identity mapping을 사용해 `jiyun@example.com`을 `jiyun` role로 매핑하는 것입니다. 이때 mapping은 단순한 편의 기능이 아니라 인가 경계입니다. `delegate_ident_mapping`처럼 validator에 매핑 책임을 위임하는 고급 옵션은 유연하지만, validator가 “이 토큰의 사용자가 요청한 role을 정말 사용할 수 있는가”까지 올바르게 판단해야 합니다. 공식 문서가 주의를 요구하는 이유입니다.

사람별 role과 권한 role을 분리하면 권한 회수가 쉬워집니다. 예를 들어 `CREATE ROLE report_reader NOLOGIN;`으로 읽기 권한을 모으고, `GRANT report_reader TO jiyun;`처럼 사람 role에 멤버십을 부여합니다. 새 입사자에게는 로그인 identity와 적절한 그룹 role만 연결합니다. 토큰 claim에 곧바로 `SUPERUSER` 같은 개념을 넣고 자동으로 최고 권한으로 매핑하는 방식은 피해야 합니다. DB 최고 권한은 운영체제 접근, 확장 설치, role 관리까지 이어질 수 있어 별도의 강한 통제가 필요합니다.

RLS(Row-Level Security)가 필요한 애플리케이션도 OAuth 인증과 혼동하면 안 됩니다. OAuth identity는 “누구로 접속했는가”를 알려 줄 수 있지만, 한 connection pool role로 모든 요청을 처리한다면 DB는 요청별 최종 사용자를 자동으로 알지 못합니다. tenant ID를 안전하게 전달하는 애플리케이션 설계, `SET LOCAL`과 권한 검증, 별도 role 전략이 필요합니다. 연결 인증을 현대화한다고 multitenancy 인가 모델이 저절로 생기지는 않습니다.

## 사람 접속과 애플리케이션 접속을 구분하기

OAuth Device Authorization은 SSH로 분석 서버에 접속해 `psql`을 실행하는 사람처럼 브라우저가 항상 곁에 있지 않은 대화형 사용 사례에 잘 맞을 수 있습니다. 사용자는 URL과 코드를 보고 IdP에서 인증·동의하고, 제한된 시간의 token으로 접속합니다. 비밀번호를 복사해 여러 곳에 저장하지 않아도 되고, IdP의 MFA(Multi-Factor Authentication)와 계정 비활성화를 활용할 여지가 있습니다.

반면 웹 API 서버의 connection pool은 사람이 매 연결마다 브라우저에서 코드를 입력할 수 없습니다. 앱이 장기 실행되고 다수의 사용자 요청을 하나 또는 소수의 DB connection으로 처리하는 구조라면, 어떤 OAuth flow를 쓸지와 token refresh·회전·비밀 보관·장애 시 동작을 별도로 설계해야 합니다. service-to-service client credential을 쓸 수 있는지, workload identity와 short-lived token을 지원하는지, 또는 현재의 SCRAM 비밀을 secrets manager로 회전하는 편이 더 단순하고 안전한지를 비교합니다.

특히 사용자 OAuth token을 애플리케이션 서버가 받아 그대로 DB에 전달하는 설계는 신중해야 합니다. token의 audience가 DB를 대상으로 발급됐는지, API가 token을 보관할 자격이 있는지, connection pool에서 다른 사용자 요청과 섞이지 않는지, 로그·오류 추적에 token이 남지 않는지 확인해야 합니다. 사용자별 세밀한 DB 권한을 원한다면 그 이점과 pool 복잡성·감사 요구를 함께 검토합니다. 모든 문제에 end-user delegation이 정답은 아닙니다.

## 운영에서 보는 보안과 가용성

OAuth 접속은 인증 인프라에 새로운 의존성을 만듭니다. IdP discovery endpoint, JWKS, introspection API가 느리거나 장애가 나면 새 DB 연결이 실패하거나 지연될 수 있습니다. 이미 열린 connection이 계속 유효한지, token 만료 뒤 재접속이 실패하면 애플리케이션이 어떻게 재시도하는지, connection pool이 한꺼번에 reconnect하며 IdP를 과부하시키지 않는지 점검해야 합니다. 중앙 인증의 가용성은 DB 가용성의 일부가 됩니다.

토큰 수명도 균형 문제입니다. 너무 긴 access token은 유출되었을 때 피해 시간이 길어지고, 너무 짧으면 connection churn과 refresh 실패가 늘 수 있습니다. 정답 숫자는 조직의 위험·IdP·클라이언트 특성에 따라 다릅니다. 중요 시스템에서는 짧은 수명, 안전한 refresh, 강한 MFA, 네트워크 제한을 조합할 수 있고, 배치 계정에는 인간 사용자와 다른 수명·승인 절차가 필요할 수 있습니다. 만료 시간을 늘려 운영 문제를 덮기보다 실패 시 재인증 경로를 설계합니다.

감사 로그도 두 층으로 남깁니다. IdP는 누가 언제 token을 요청·발급받았는지 기록할 수 있고, PostgreSQL은 어떤 role로 어느 database에 접속했는지 기록합니다. 두 로그의 시간대·identity·correlation 단서를 맞춰야 조사에 도움이 됩니다. 비밀번호나 bearer token 값 자체를 PostgreSQL log, connection string, APM trace에 남기지 않도록 로그 수준과 마스킹을 확인합니다. OAuth 디버그 기능은 개발을 돕지만 민감한 HTTP 트래픽을 출력할 수 있으므로 운영에서 사용하면 안 됩니다.

## 단계적 도입 예시

첫 단계는 영향이 작은 대화형 읽기 전용 경로 하나를 고르는 것입니다. 예를 들어 별도 분석 database에서 제한된 `analyst` role로 `psql` 접속을 하는 경우입니다. 운영 애플리케이션 pool과 최고 권한 계정은 그대로 두고, 새 `oauth` HBA 규칙을 특정 CIDR과 database에만 적용합니다. 이 단계에서 IdP issuer 일치, TLS, user mapping, 만료된 토큰, 권한 없는 scope, IdP 장애를 확인합니다.

두 번째는 role과 권한 모델을 정리하는 일입니다. 개인별 role을 만들지, 그룹 role을 멤버십으로 줄지, 외부 협력사 identity를 어떻게 처리할지, 퇴사·부서 이동 뒤 멤버십이 언제 반영되는지 합의합니다. 기존 비밀번호 role을 OAuth role로 바로 덮어쓰지 말고, 롤백 가능한 병행 기간을 둡니다. 자동화 계정은 사람 OAuth와 분리해 어느 팀이 owner인지, secret 또는 workload identity를 어떻게 회전하는지 문서화합니다.

세 번째는 관찰과 장애 훈련입니다. 정상 접속·거부된 접속·만료·issuer 장애·validator 오류를 각각 만들고, DBA와 IdP 운영자가 어느 로그를 먼저 볼지 runbook에 씁니다. 인증 오류가 발생했을 때 개발자가 `trust` HBA 규칙을 임시로 추가해 우회하지 않도록, 안전한 긴급 접근 계정과 승인 절차를 미리 마련해야 합니다. 인증 현대화의 목적은 편리함뿐 아니라 예측 가능한 통제와 복구입니다.

## validator를 직접 만들기 전에 확인할 것

PostgreSQL 18의 validator API가 있다는 사실은 곧 직접 C 확장 모듈을 작성해야 한다는 뜻은 아닙니다. 먼저 조직이 사용하는 IdP가 제공하는 PostgreSQL 통합 구성 요소, 검토된 오픈 소스 구현, 또는 이미 승인된 인증 프록시가 있는지 확인합니다. validator는 데이터베이스 서버 프로세스 안에서 token 검증의 마지막 판단을 내리는 코드입니다. 구현이 잘못되면 만료된 token, 다른 audience의 token, 서명이 다른 token을 받아들여 권한 없는 접속으로 이어질 수 있습니다. 보안 경계 코드의 작은 편의 구현은 장기 운영 비용보다 위험할 수 있습니다.

공급자 통합을 평가할 때는 지원되는 token 형식부터 묻습니다. JWT처럼 서명된 자체 포함 token이면 어느 공개 키 집합을 어떤 refresh 정책으로 가져오는지, `kid`가 바뀔 때 어떤 동작을 하는지, 키 서버가 일시적으로 응답하지 않을 때 이미 가진 키로 어디까지 검증하는지 확인합니다. opaque token이면 introspection endpoint로 매번 또는 캐시를 두고 확인할 수 있는데, 이 경우 IdP 네트워크 지연과 장애가 DB 신규 연결에 영향을 줍니다. token 검증 결과를 너무 오래 캐시하면 권한 회수 반영이 늦고, 전혀 캐시하지 않으면 IdP 부하와 접속 지연이 커질 수 있습니다.

claim 검증도 이름 하나만 비교하는 문제가 아닙니다. `iss`는 신뢰한 authorization server인지, `aud`는 해당 token이 PostgreSQL resource server를 위해 발급됐는지, `exp`와 `nbf`는 현재 시간에 유효한지, scope나 group claim은 기대한 권한을 포함하는지 봐야 합니다. 시계가 몇 분 어긋난 서버에서 만료 검증이 어떻게 되는지, 여러 tenant issuer를 받을 때 tenant 간 identity가 충돌하지 않는지도 설계합니다. 이메일 주소는 사람이 읽기 좋지만 변경될 수 있으므로, 안정적인 subject ID와 표시 이름을 어떤 용도로 나눌지도 IdP 담당자와 합의합니다.

validator 실패 정책은 보수적으로 설계합니다. 권한 검증에 필요한 정보를 얻을 수 없으면 접속을 거절하는 fail closed가 일반적으로 안전합니다. 다만 인증 인프라 장애가 곧 분석 작업과 운영 절차 전체의 중단이 될 수 있으므로, 사전에 제한된 break-glass 계정과 감사 절차를 별도로 준비합니다. 이 계정은 일상적인 편의를 위한 공유 비밀번호가 아니라, 사용 이유·승인자·사용 시간·후속 비밀 회전이 남는 예외 경로여야 합니다.

## connection pool과 token 수명을 함께 설계하기

JDBC, psycopg, Npgsql 같은 드라이버의 connection pool은 매 요청마다 새 인증을 하지 않고 미리 열린 연결을 빌려 쓰는 경우가 많습니다. OAuth access token의 만료 시각과 pool connection의 수명이 다르면, 처음에는 정상 동작하다가 오래 살아 있는 작업자가 재연결할 때만 인증 실패가 날 수 있습니다. token refresh 직후 새 연결이 열리는지, 기존 연결은 언제 닫히는지, 배포 중 모든 인스턴스가 동시에 reconnect하지 않게 jitter를 둘지 확인해야 합니다.

사람의 psql 접속에서 token 만료는 다시 로그인하면 되는 불편일 수 있습니다. 하지만 API 서버가 DB에 연결하지 못하면 고객 요청이 실패할 수 있습니다. 그래서 애플리케이션 연결에 OAuth를 적용하려면 token broker, workload identity, client credential, secret rotation 중 무엇을 쓸지 선택하고, 토큰 발급 실패 때 재시도를 얼마나 할지와 사용자에게 어떤 오류를 줄지 정해야 합니다. IdP가 잠시 느려진 상황에서 connection pool 전체가 비어 버리면 재시도 폭주가 발생할 수 있으므로 exponential backoff와 최대 대기 시간도 필요합니다.

connection pooler를 사용하는 경우에는 더 명확한 경계가 필요합니다. PgBouncer 같은 구성 요소가 클라이언트와 PostgreSQL 사이에 있으면, OAuth handshake를 어느 구간에서 처리하는지, pooler가 사용자별 identity를 보존하는지, transaction pooling에서 세션 설정과 role이 섞이지 않는지 검토해야 합니다. 인증이 앞단에서 끝난다는 이유로 DB role을 하나의 고권한 계정에 몰아주면 감사와 최소 권한의 장점을 잃습니다. 반대로 사용자별 DB 연결을 무제한 만들면 DB 자원과 운영 복잡성이 커집니다.

실무에서는 사람의 대화형 접속, 백오피스 도구, 애플리케이션 runtime, 배치, 백업·복제 계정을 하나의 방식으로 억지로 통일하지 않는 편이 낫습니다. 각 경로의 주체, 연결 지속 시간, 장애 영향, 필요한 감사 수준을 표로 정리하고 OAuth가 실제로 줄여 주는 문제를 확인합니다. 인증 방법을 늘리는 것 자체가 보안 목표가 아니라, 비밀번호 분산과 계정 수명 관리라는 구체적인 위험을 낮추는 것이 목표입니다.

## 전환 검증 체크리스트

도입 전에 클라이언트 호환성을 확인합니다. 오래된 `psql`, 오래된 libpq를 정적 링크한 배치 프로그램, GUI 툴, ETL 도구는 OAuth SASL을 지원하지 않을 수 있습니다. 서버가 OAuth HBA 규칙을 먼저 만나면 지원하지 않는 client는 접속하지 못할 수 있으므로, HBA 규칙 순서와 주소 범위를 설계합니다. 테스트 환경에서 지원 client와 미지원 client, TLS 성공과 실패, 올바른 issuer와 비슷하지만 다른 issuer를 모두 확인합니다.

권한 검증은 접속 성공만 보지 않습니다. `report_reader`가 허용된 view만 읽는지, 쓰기 권한이 거부되는지, 다른 database에 접속할 수 없는지, RLS가 적용되는지까지 확인합니다. 사람 계정의 group이 IdP에서 바뀐 뒤 새 token에서 언제 반영되는지, role 멤버십을 회수하면 열린 세션과 새 세션이 각각 어떻게 되는지도 기록합니다. 인증 사고는 대개 “접속이 됐다”보다 “예상보다 많이 할 수 있었다”에서 시작합니다.

마지막으로 rollback을 시험합니다. 새 OAuth 규칙을 제거하거나 좁힐 때 기존 인증 경로가 의도한 사용자에게만 남는지, validator 라이브러리 오류가 서버 시작이나 reload에 어떤 영향을 주는지, 긴급 계정 사용 뒤 비밀 회전과 감사 확인을 어떻게 하는지 점검합니다. 운영에서 처음 만나는 인증 변경은 가장 어려운 장애가 되기 쉽습니다. 작은 범위에서 실패와 복구를 먼저 경험하는 것이 전체 전환보다 안전합니다.

## 문서와 책임 경계를 남기는 방법

OAuth 접속 설계 문서에는 최소한 네 가지 표가 있으면 좋습니다. 첫째는 접속 주체 목록입니다. 사람의 psql, BI 도구, 애플리케이션, 배치, 백업·복제·모니터링이 각각 어떤 인증을 쓰는지 적습니다. 둘째는 identity mapping입니다. IdP의 subject·group·email 중 무엇을 database role과 연결하며, 변경·삭제가 언제 반영되는지 정합니다. 셋째는 권한 표입니다. 로그인 role, NOLOGIN 그룹 role, database·schema·table·function 권한, RLS 적용 여부를 분리합니다. 넷째는 장애 책임 표입니다. issuer discovery 실패, token 발급 실패, validator 검증 실패, DB role 권한 거부에서 각 담당자와 확인 로그를 연결합니다.

이 문서가 필요한 이유는 OAuth가 여러 팀의 경계에 걸쳐 있기 때문입니다. DBA는 HBA와 role을, 플랫폼 팀은 네트워크와 TLS를, IdP 팀은 client 등록과 claim을, 애플리케이션 팀은 pool과 오류 처리를 다룹니다. 어느 한 팀이 “토큰이 왔다” 또는 “DB가 거절했다”만 말하면 원인이 오래 남습니다. 접속 흐름의 owner와 변경 승인자를 정하고, IdP 설정 변경과 PostgreSQL 배포가 독립적으로 일어날 때 호환성을 어떻게 확인할지도 기록합니다.

보안 검토에서는 토큰 탈취만 보지 말고 과도한 권한과 잘못된 감사도 봅니다. 예를 들어 analytics role이 프로덕션 원본 테이블 전체를 읽는 대신 필요한 view만 읽도록 만들 수 있는지, 사용자 role이 다른 role로 `SET ROLE` 할 수 있는지, `search_path`와 SECURITY DEFINER 함수가 예상보다 넓은 권한을 주지 않는지 확인합니다. OAuth는 접속 입구의 identity를 개선하지만 SQL 권한 설계의 실수를 고치지 않습니다.

마지막으로 사용자 경험을 고려합니다. 브라우저 없는 서버에서 device flow 안내가 잘 보이는지, 만료 뒤 사용자에게 어떤 URL과 오류를 안내하는지, GUI 툴이 지원하지 않을 때 안전한 대체 경로가 있는지 확인합니다. 인증이 지나치게 어렵다면 사람들은 토큰을 파일에 오래 저장하거나 공유 계정을 만들려 할 수 있습니다. 안전한 기본 경로가 실제로 사용하기 쉬워야 우회가 줄어듭니다.

## 일상 운영에서 확인할 신호

OAuth 도입 뒤에는 단순한 로그인 성공률 외에 인증 경계가 건강한지 관찰합니다. 신규 접속의 성공·실패 비율을 database, application name, source network, HBA 규칙 단위로 볼 수 있으면 특정 도구 업그레이드나 issuer 장애를 빨리 구분할 수 있습니다. 단, 로그에 bearer token, authorization header, client secret를 남겨서는 안 됩니다. 오류 메시지에는 사용자 안내에 필요한 범위만 담고, 상세 token 검증 실패 사유는 권한 있는 운영자가 보는 안전한 로그에 분리합니다.

권한 변경도 정기적으로 재검토합니다. IdP group과 PostgreSQL role 멤버십이 같은 의미로 유지되는지, 더 이상 쓰지 않는 개인 role·서비스 계정·HBA 예외가 남지 않았는지 확인합니다. access review는 “누가 로그인할 수 있는가”와 “누가 민감 테이블을 읽거나 role을 변경할 수 있는가”를 함께 봐야 합니다. 특히 개발·스테이징 편의를 위해 만든 넓은 `all all` 규칙이 운영에 복사되지 않도록 환경별 설정을 분리합니다.

인증 시스템의 시간도 운영 요소입니다. token의 만료와 not-before 검증은 서버 시계에 의존하므로, PostgreSQL 노드와 validator가 NTP 등으로 합리적인 시간 동기화를 유지해야 합니다. 시계가 크게 어긋나면 정상 token이 만료로 보이거나 아직 유효하지 않은 token을 받아들이는 혼란이 생길 수 있습니다. IdP 장애, DNS 실패, 인증서 만료, 공개 키 회전 같은 이벤트를 모니터링 목록에 넣고, 단순 DB 장애와 동일한 우선순위로 대응 절차를 준비합니다.

이 신호를 바탕으로 처음의 설계를 조정할 수 있습니다. 특정 BI 도구가 OAuth를 지원하지 않아 임시 비밀번호를 계속 쓴다면, 예외를 무기한 두기보다 도구 교체·드라이버 업데이트·제한된 jump host 중 어떤 경로가 장기적으로 안전한지 검토합니다. 반대로 대화형 접속에서는 OAuth가 잘 작동해도 자동화 계정에는 과도한 복잡성이라면, 역할과 위험에 맞는 별도 인증 방식을 유지할 수 있습니다. 통일성보다 책임과 복구 가능성이 더 중요한 기준입니다.

정기 점검의 결과는 단순한 보안 보고서로 끝내지 말고 HBA 규칙, role 멤버십, IdP client 설정, runbook의 실제 변경으로 연결해야 합니다. 그래야 시간이 지나도 설계 의도가 유지됩니다.

작은 접속 경로에서 시작해 검증 범위를 넓히는 방식이, 한 번의 전면 전환보다 계정과 데이터의 위험을 낮춥니다.

## 한계와 적용 기준 Q&A

<section class="quick-answers">
  <p class="quick-label">한계와 적용 기준</p>
  <div class="quick-answer"><h3>Q. OAuth가 SCRAM보다 항상 더 안전한가요?</h3><p>A. 아닙니다. OAuth는 중앙 IdP·MFA·짧은 토큰과 잘 결합할 수 있지만, validator와 issuer 신뢰를 잘못 설계하면 위험합니다. 단순한 내부 서비스 계정에는 회전되는 SCRAM 비밀과 TLS가 더 적절할 수 있습니다.</p></div>
  <div class="quick-answer"><h3>Q. JWT를 디코딩해 이메일만 비교하면 validator가 되나요?</h3><p>A. 안 됩니다. 서명, issuer, 만료, audience, scope 등 신뢰 조건을 검증해야 합니다. base64 디코딩은 token이 변조되지 않았음을 증명하지 못합니다.</p></div>
  <div class="quick-answer"><h3>Q. OAuth token이 있으면 SUPERUSER role을 자동으로 줘도 되나요?</h3><p>A. 매우 위험합니다. 인증된 identity와 최고 DB 권한은 다른 문제입니다. 최고 권한은 별도 승인·강한 다중 통제·감사 정책을 적용해야 합니다.</p></div>
  <div class="quick-answer"><h3>Q. PostgreSQL 18로 업그레이드하면 기존 비밀번호 접속이 멈추나요?</h3><p>A. 아닙니다. OAuth는 새 인증 선택지입니다. 다만 HBA 규칙 순서와 client 지원 여부를 검토하지 않고 바꾸면 특정 경로가 예상치 않게 다른 규칙과 매칭될 수 있습니다.</p></div>
</section>

## 마무리: 토큰 검증과 데이터 권한을 분리해 설계하기

PostgreSQL 18의 OAuth 인증은 중앙 identity 체계와 데이터베이스 접속을 연결할 수 있는 중요한 기반입니다. 그러나 기능의 중심은 토큰을 받는 한 줄의 HBA 설정이 아니라, 신뢰할 issuer, 안전한 validator, 명확한 role mapping, TLS, 로그와 장애 대응을 함께 설계하는 데 있습니다.

처음에는 사람의 읽기 전용 접속처럼 범위가 좁고 롤백이 쉬운 경로에서 시작하는 편이 좋습니다. 누가 접속했는지 확인하는 OAuth와, 그 사용자가 무엇을 할 수 있는지 제한하는 PostgreSQL 권한 모델을 분리하면 인증 현대화가 권한 과다 부여로 흐르는 일을 줄일 수 있습니다.

<h3 class="references-heading">참고 자료</h3>

- [PostgreSQL 18 OAuth Authorization/Authentication](https://www.postgresql.org/docs/18/auth-oauth.html)
- [PostgreSQL 18 OAuth Support in libpq](https://www.postgresql.org/docs/18/libpq-oauth.html)
- [PostgreSQL 18 OAuth Validator Modules](https://www.postgresql.org/docs/18/oauth-validators.html)
- [PostgreSQL 18 SASL OAUTHBEARER Authentication](https://www.postgresql.org/docs/18/sasl-authentication.html)
- [OAuth 2.0 Authorization Framework, RFC 6749](https://datatracker.ietf.org/doc/html/rfc6749)
- [OAuth 2.0 Device Authorization Grant, RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628)
