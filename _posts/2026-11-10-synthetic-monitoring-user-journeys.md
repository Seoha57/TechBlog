---
layout: post
title: "Synthetic Monitoring을 설계하는 법: 사용자 여정·알림·실패 진단으로 서비스 점검하기"
categories: [QA]
tags: [qa, synthetic-monitoring, observability, user-journey, reliability]
description: "Synthetic Monitoring의 기본 개념부터 사용자 여정 점검, 알림 기준, 테스트 계정과 실패 진단을 설명하고 실제 사용자 관찰과 함께 운영하는 방법을 정리합니다."
---

## 먼저 답하기

### Q. Synthetic Monitoring은 E2E 테스트를 운영에서 계속 돌리는 것인가요?

A. 비슷한 도구를 쓸 수 있지만 목적이 다릅니다. E2E 테스트는 변경이 기능 요구를 지키는지 확인하는 데 중심을 둡니다. Synthetic Monitoring은 정해진 시간마다 외부 또는 지정된 관점에서 대표 요청을 실행해 지금 서비스가 실제로 접근·로그인·조회·결제 준비 같은 기본 여정을 수행할 수 있는지 관찰합니다. 배포가 없어도 DNS, 인증서, CDN, 외부 의존성, 계정 정책 변화로 서비스가 실패할 수 있기 때문에 운영 신호가 필요합니다.

### Q. 실제 사용자 지표가 있으면 Synthetic Monitoring은 필요 없나요?

A. 실제 사용자 모니터링은 고객이 겪은 문제를 보여 주지만, 트래픽이 적은 시간이나 특정 국가·브라우저·관리자 기능의 실패를 늦게 발견할 수 있습니다. Synthetic Monitoring은 미리 정한 중요한 경로를 일정하게 확인합니다. 다만 가짜 요청이 실제 고객의 모든 환경을 대표하지는 않으므로, 두 신호를 경쟁시키기보다 서로 다른 빈틈을 채우게 해야 합니다.

## 먼저 알아둘 기반 기술

### 관찰 가능성과 블랙박스 점검

관찰 가능성(observability)은 로그·지표·trace 같은 신호로 시스템 내부 상태를 추론하는 능력입니다. Synthetic Monitoring은 이 중 사용자가 보는 경계에서 결과를 수집하는 블랙박스 점검에 가깝습니다. 내부 CPU가 정상이어도 DNS가 잘못됐거나 TLS 인증서가 만료됐거나 로그인 redirect가 깨지면 고객은 서비스를 쓸 수 없습니다. HTTP 200 하나만 확인하는 health check보다, 중요한 화면·API·인증 흐름을 실제 요청으로 확인하는 이유가 여기에 있습니다.

### 사용자 여정과 SLI

사용자 여정(user journey)은 고객이 목표를 이루기 위해 밟는 단계입니다. 쇼핑 서비스라면 홈 접속, 상품 검색, 장바구니, 로그인, 결제 직전 확인이 될 수 있습니다. SLI(Service Level Indicator)는 서비스 상태를 나타내는 측정값으로 성공 여부, 응답 시간, 오류 비율, 페이지의 핵심 요소 존재 여부 등이 될 수 있습니다. SLO(Service Level Objective)는 이 지표에 대해 팀이 정한 목표입니다. Synthetic check는 SLI를 만드는 입력 중 하나이며, 숫자를 모으는 것보다 어떤 실패가 사용자 목표를 막는지 표현해야 합니다.

### 테스트 계정과 멱등성

운영에서 주문 생성이나 비밀번호 변경을 반복하면 실제 데이터와 고객 경험에 영향을 줄 수 있습니다. 그래서 synthetic journey는 전용 test account, sandbox 결제 수단, test tenant, 정해진 fixture를 사용하고 가능한 한 읽기 또는 되돌릴 수 있는 동작을 선택합니다. 멱등성(idempotency)은 같은 요청을 여러 번 보내도 의도하지 않은 중복 결과가 생기지 않는 성질입니다. monitor가 timeout 뒤 재시도할 수 있다는 점을 고려하지 않으면 테스트가 스스로 주문·이메일·알림을 중복 생성하는 장애 원인이 될 수 있습니다.

## 무엇을 점검할지 고르는 기준

모든 화면을 synthetic check로 만들면 비용·관리·오경보가 늘어납니다. 먼저 실패했을 때 고객·매출·권한·운영 대응에 영향이 큰 여정을 고릅니다. 로그인, 회원 가입, 검색, 주문 시작, 파일 업로드, 관리자 승인처럼 서비스의 핵심 약속이 후보가 됩니다. 각 여정에는 시작 조건, 성공 조건, 허용 시간, 사용 계정, 외부 의존성, 실패 시 담당자를 적습니다.

예를 들어 "로그인 페이지가 열린다"와 "사용자가 로그인해 권한 있는 대시보드를 본다"는 다른 check입니다. 전자는 DNS·TLS·정적 자산·route 문제를 발견하는 데 좋고, 후자는 인증 provider·cookie·redirect·권한 정책 문제를 더 발견할 수 있습니다. 두 번째가 더 넓은 신호를 주지만 계정 만료·MFA·rate limit·테스트 데이터 관리가 필요합니다. 넓은 check 하나만 두기보다, 실패 원인을 구분할 수 있는 작은 check와 대표 여정을 함께 두는 편이 진단에 유리합니다.

성공 조건도 화면이 빈 흰색이 아닌지보다 구체적이어야 합니다. HTTP 상태, 로그인 뒤 사용자 이름이나 권한 표시, 검색 결과의 특정 test fixture, API 응답 schema, checkout 단계 진입처럼 사용자 가치와 연결합니다. 단, production data나 실제 고객 정보를 결과에 기대값으로 쓰지 않습니다. 전용 fixture를 만들고, monitor 로그에 개인정보·token·세션 cookie가 남지 않게 합니다.

## check 종류를 층으로 나누기

가장 아래에는 DNS 조회, TCP 연결, TLS handshake, HTTP status처럼 빠른 availability check가 있습니다. 이 check는 장애를 빨리 알려 주지만 로그인 성공이나 데이터 정합성까지 말해 주지는 않습니다. 중간에는 API synthetic check가 있습니다. 인증된 token으로 `GET /profile`이나 제한된 test resource 조회를 실행해 gateway·인증·backend 응답을 확인할 수 있습니다. 위쪽에는 실제 브라우저에서 로그인하고 핵심 작업을 하는 journey check가 있습니다.

이 층은 테스트 피라미드와 비슷하게 비용과 진단 범위를 나누는 데 쓸 수 있습니다. 모든 1분 check를 브라우저로 만들 필요는 없습니다. DNS·HTTP·API check는 짧은 주기로, 브라우저 journey는 더 긴 주기로 실행할 수 있습니다. 한 check가 실패했을 때 아래 check가 정상이라면 UI·인증·특정 의존성을 먼저 보고, 모두 실패했다면 더 넓은 네트워크 또는 서비스 장애를 조사할 수 있습니다.

외부 provider를 포함하는 check는 특히 조심합니다. 결제 provider sandbox, 이메일 수신함, OAuth identity provider는 production과 완전히 같지 않을 수 있습니다. synthetic 결과가 정상이라고 실제 결제가 정상이라고 단정하지 않고, 외부 dependency 상태를 나타내는 추가 signal로 해석합니다. 반대로 provider sandbox가 실패했다고 고객 production 흐름이 반드시 실패한 것도 아닙니다. 의존성별로 무엇을 검증하는지 문서화해야 합니다.

## 알림은 실패 횟수가 아니라 행동을 위해 만든다

한 번의 timeout마다 모든 사람에게 page를 보내면 alert fatigue가 생깁니다. 반대로 여러 지역에서 핵심 로그인 journey가 연속 실패해도 알림이 없으면 탐지가 늦습니다. alert 조건은 여정의 중요도, 반복 횟수, 여러 location의 동시 실패, 실제 사용자 오류 지표, 현재 배포 여부를 함께 고려합니다. 예를 들어 단일 location의 한 번 실패는 ticket이나 재시도로 처리하고, 두 지역에서 세 번 연속 실패하며 실제 로그인 오류도 증가하면 on-call에 알릴 수 있습니다.

알림에는 실패했다는 문장만 넣지 말고 check 이름, region, 실패 단계, 최근 성공 시각, screenshot 또는 trace 위치, 관련 dashboard와 runbook 링크를 넣습니다. 그래야 on-call이 새벽에 dashboard를 처음부터 찾지 않아도 됩니다. 다만 screenshot과 trace에는 사용자 데이터가 노출될 수 있으므로 전용 계정·마스킹·접근 제어·보관 기간을 적용합니다.

억제(suppression)와 maintenance window도 필요합니다. 계획된 배포·DB migration·identity provider 변경 중에는 일부 check가 예상대로 실패할 수 있습니다. 그렇다고 monitor를 전체 off하면 실제 별도 장애를 놓칠 수 있습니다. 가능한 한 영향받는 check와 시간 범위를 좁게 mute하고, 끝난 뒤 자동으로 해제되는지 확인합니다. 배포 후 check가 계속 실패하면 maintenance라는 이유로 오래 무시하지 말고 release rollback 또는 incident 절차로 전환해야 합니다.

## 실패를 진단 가능한 증거로 남기기

synthetic test가 실패하면 "서비스가 느리다"만으로는 고칠 수 없습니다. URL, HTTP 상태, DNS 결과, TLS 오류, 요청 단계별 시간, 브라우저 console error, network waterfall, trace ID, deployment version, check location을 연결합니다. 이 정보는 API gateway 오류인지, JavaScript bundle 배포 누락인지, 인증 cookie domain 설정인지, 특정 region의 DNS 문제인지 좁히게 해 줍니다.

실패 artifact를 전부 무기한 저장하는 것은 위험합니다. trace와 HAR 파일에는 header·query parameter·응답 body가 들어갈 수 있습니다. test account라도 session token이나 내부 URL이 노출될 수 있으므로, 민감 header를 마스킹하고 접근 가능한 사람을 제한하며 보관 기간을 짧게 둡니다. 필요한 경우 실패 유형과 request ID만 장기 지표로 남기고, 상세 artifact는 incident 기간에만 보관합니다.

flaky check도 product 결함처럼 관리합니다. 실패 뒤 재시도해 초록색이 됐다는 이유로 원인을 닫으면, 실제 장애와 도구 잡음을 구분할 수 없게 됩니다. 네트워크 간헐성, 시간 의존 test data, 느린 API, selector 변경, shared account 충돌을 분류하고, 반복 실패율과 재시도 횟수를 지표로 봅니다. 신뢰하지 못하는 monitor는 알림을 줄이는 것이 아니라 서비스를 보지 못하게 만듭니다.

## location과 네트워크 경계를 해석하기

synthetic check는 어느 위치에서 실행했는지가 결과의 일부입니다. 국내 한 region에서만 실행하면 해당 ISP, DNS resolver, CDN edge, firewall 경로에서 보이는 문제는 찾을 수 있지만 해외 고객의 연결 문제는 놓칠 수 있습니다. 반대로 여러 대륙에서 동시에 실행하면 더 넓은 장애를 볼 수 있지만, 각 location의 일시적인 네트워크 손실을 서비스 장애로 오인할 가능성도 커집니다. 서비스 사용자의 지역과 중요도를 기준으로 location을 정하고, 하나의 location 실패와 다수 location 동시 실패의 alert 의미를 다르게 둡니다.

사내 서비스는 public internet이 아닌 VPN, private DNS, bastion, zero-trust proxy를 거칠 수 있습니다. 이 경우 외부 synthetic runner가 실패했다고 내부 사용자가 실패하는 것은 아닐 수 있고, 내부 runner만 성공한다고 외부 고객이 정상이라는 보장도 없습니다. 관찰 지점을 사용 경로와 맞춥니다. 고객용 web은 외부 region에서, 직원용 업무 도구는 승인된 내부 network에서, public API는 partner가 실제로 쓰는 ingress 경계에서 check할 수 있습니다.

network check가 실패했을 때 DNS record, TLS certificate, redirect chain, CDN response header, connection timeout을 분리해 기록하면 책임 경계를 좁히기 쉽습니다. 예를 들어 DNS는 정상인데 TLS handshake만 실패하면 certificate renewal 또는 proxy 설정을, 첫 HTML은 정상인데 JavaScript asset만 404면 build·CDN purge·base path를 우선 봅니다. 단, 내부 IP나 보안 header를 alert 메시지에 그대로 넣지 않도록 합니다.

## 브라우저 journey를 안정적으로 작성하는 원칙

브라우저 check는 사람이 클릭하는 모습을 그대로 녹화하는 것보다, 사용자의 목표와 준비 상태를 명시하는 script가 안정적입니다. 버튼이 보일 때까지 임의로 10초를 자는 대신, 로그인 완료 뒤 특정 role의 element가 나타나는지, API 응답이 완료됐는지, navigation이 예상 URL로 끝났는지를 기다립니다. CSS class나 화면 문구는 디자인·번역 변경에 흔들릴 수 있으므로 접근성 역할, label, 안정적인 test id를 적절히 사용합니다.

그러나 test id를 모든 화면 요소에 과도하게 추가하면 production markup이 test 전용 구조에 묶일 수 있습니다. 사용자가 실제로 인식하는 label·role로 충분한 곳은 그것을 쓰고, 반복적으로 깨지는 동적 요소나 목록 항목에는 최소한의 test hook을 둡니다. selector를 바꾸는 pull request도 monitor 변경으로 취급해, 해당 user journey가 왜 필요한지와 실패 artifact가 어디에 남는지 함께 리뷰합니다.

로그인 뒤 MFA나 CAPTCHA가 필요한 서비스는 synthetic account의 예외 정책을 함부로 만들면 보안이 약해질 수 있습니다. 전용 test tenant, 제한된 network, 승인된 service identity, sandbox identity provider를 쓰는 방법을 보안 팀과 검토합니다. monitor 편의를 위해 실제 관리자 계정의 MFA를 해제하거나 장기 token을 코드에 넣으면, availability check가 새로운 침해 경로가 됩니다.

## 배포와 synthetic check를 연결하기

배포 전 테스트가 통과했더라도 route, CDN, environment variable, secret, ingress, feature flag가 production에서 다르면 고객 경로는 실패할 수 있습니다. 그래서 배포 뒤 synthetic journey를 release validation에 연결할 수 있습니다. 새 version이 일정 비율의 traffic을 받는 동안 특정 check가 연속 실패하거나 핵심 API 오류율이 오르면 rollout을 멈추고, artifact와 deployment change를 함께 조사합니다.

이때 monitor가 배포를 자동 rollback하는 권한을 가질지 신중히 결정합니다. 고객 금전·권한에 영향이 큰 release는 빠른 중단이 필요할 수 있지만, transient external failure 하나로 자동 rollback하면 더 큰 혼란을 만들 수 있습니다. 기본은 alert와 명확한 runbook으로 시작하고, 안정적으로 검증된 낮은 위험 경로에만 제한된 자동 조치를 검토합니다. rollback 뒤에도 이전 version의 check가 실제로 회복됐는지 확인해야 합니다.

feature flag가 있는 기능은 flag on·off 상태를 구분해 check합니다. 새 checkout이 flag on에서만 실패하는데 monitor가 flag off 계정으로 실행되면 정상이라는 잘못된 신호를 줍니다. 반대로 실험 대상이 아닌 고객에게 flag를 억지로 켜는 synthetic account는 실험 데이터와 제품 분석을 오염시킬 수 있습니다. test tenant와 rollout 정책을 연결하고, 어떤 flag 조합을 점검하는지 release 기록에 남깁니다.

## test data의 생성·정리·감사

synthetic journey는 시간이 갈수록 주문, 파일, 알림, session, cache를 만들 수 있습니다. 이 데이터가 계속 쌓이면 검색 결과가 느려지거나 quota가 차고, check 자체가 예상 조건에서 시작하지 못합니다. 생성하는 resource에는 `synthetic=true` 같은 명시적 표식을 두고, cleanup job이 어떤 데이터를 언제 삭제하는지 정합니다. cleanup이 실패했을 때는 자동으로 모든 데이터를 지우기보다, 식별 가능한 목록과 승인된 절차로 조사합니다.

test account도 제품 권한 모델의 일부입니다. 최소 권한을 주고, 실제 고객 데이터와 같은 tenant를 쓰지 않으며, password·token·recovery method를 rotation합니다. 직원 퇴사나 team 이동으로 account owner가 사라질 수 있으므로 개인 계정에 의존하지 않습니다. credential은 secret manager에서 참조하고, browser trace·CI log·screenshot에서 마스킹되는지 확인합니다.

정상 결과의 history는 baseline을 만드는 데 쓸 수 있습니다. check가 평소 2초 안에 끝났는데 며칠 동안 8초가 된다면 아직 timeout은 아니어도 성능 저하 신호일 수 있습니다. 다만 한 번의 느린 결과로 SLO 위반을 선언하지 않고, 시간대·region·배포·외부 dependency와 함께 추세를 봅니다. monitoring data는 test account의 특성 때문에 실제 고객 latency와 다를 수 있다는 한계도 같이 기록합니다.

## 운영 역할과 runbook

monitor가 실패했을 때 누가 무엇을 하는지 정하지 않으면 alert는 단순한 채팅 알림이 됩니다. 서비스 owner는 user journey의 성공 조건과 허용 실패를 정의하고, platform team은 runner·network·credential platform을 지원하며, on-call은 runbook에 따라 영향 범위를 확인합니다. 외부 provider가 원인일 때 고객 안내, 우회 경로, provider escalation을 누가 담당하는지도 서비스 특성에 맞춰야 합니다.

runbook에는 먼저 check 자체가 정상인지 확인하는 단계가 있어야 합니다. runner 상태, 최근 script 변경, test account lock, secret rotation, 동일 시간의 다른 check 결과를 보고 monitoring system의 오류와 product 오류를 구분합니다. 다음으로 DNS·TLS·HTTP·API·browser 중 어디에서 실패했는지, 실제 사용자 지표가 같은 방향인지, 최근 배포와 config 변경이 있는지 확인합니다. 마지막으로 완화·rollback·incident 선언·고객 공지의 기준을 적습니다.

runbook은 장애 때 처음 읽는 문서가 되면 안 됩니다. 정기 game day나 비중요 환경에서 synthetic failure를 의도적으로 만들어 alert, artifact, 담당자 호출, recovery가 작동하는지 확인할 수 있습니다. 테스트 자체가 production 장애를 만들지 않도록 제한된 계정과 범위에서 시행합니다. 실제로 사용한 runbook은 incident 뒤 갱신해, 다음번에는 더 적은 추측으로 대응하게 합니다.

## 지표를 과대해석하지 않는 기준

synthetic success rate가 100%여도 실제 고객이 느린 mobile network에서 실패할 수 있고, 실제 고객 오류율이 낮아도 핵심 admin 기능이 조용히 망가졌을 수 있습니다. synthetic, RUM(Real User Monitoring), server error, business conversion, support signal을 같은 dashboard 또는 incident timeline에서 비교합니다. 서로 다른 신호가 같은 방향이면 확신이 커지고, 어긋나면 어느 사용자·경계가 빠졌는지 배우는 기회가 됩니다.

예를 들어 synthetic checkout은 정상인데 실제 결제 성공률이 떨어지면, test card와 실제 card의 인증 흐름, 특정 국가·브라우저, 결제 provider routing, 고객 데이터 조건을 조사합니다. 반대로 synthetic만 실패하고 실제 트래픽이 정상이라면 test account의 만료·sandbox outage·script selector부터 확인합니다. monitor를 "진실을 말하는 도구"가 아니라 관측 편향을 가진 측정기로 대하면, 불필요한 대규모 대응을 줄이면서도 중요한 신호를 놓치지 않을 수 있습니다.

## API check의 입력과 출력 계약

API synthetic check는 browser보다 빠르고 오류를 세밀하게 분류하기 좋습니다. 그러나 단순히 `GET /health`가 200인지 보는 것만으로는 인증된 사용자 API와 database query가 정상인지 알 수 없습니다. 읽기 전용 test resource를 준비하고, 전용 service identity 또는 최소 권한 token으로 호출하며, status code뿐 아니라 response schema와 핵심 field를 검증합니다. 예를 들어 주문 목록 API라면 test customer의 주문이 한 건 이상인지보다, tenant filter가 유지되고 `id`, `status`, `createdAt` 형식이 계약을 지키는지 확인할 수 있습니다.

API response 전체를 snapshot으로 비교하면 timestamp·request ID·배열 순서처럼 의미 없는 변화 때문에 check가 흔들릴 수 있습니다. 반대로 status만 보면 응답이 비어 있거나 권한 정보가 잘못돼도 통과합니다. 필요한 field, 허용 값, 최대 응답 시간, 금지되는 민감 field처럼 목적에 맞는 assertion을 고릅니다. schema가 바뀌는 release에서는 consumer contract와 synthetic check를 함께 갱신해, 문서와 실제 운영 점검이 다른 약속을 보지 않게 합니다.

token 만료와 rotation도 synthetic API의 실제 실패 원인입니다. token이 만료된 것은 monitor의 계정 관리 문제일 수 있지만, identity provider의 key rotation이나 audience 설정 오류가 고객 API에도 영향을 주는 신호일 수 있습니다. 401·403을 단순 "check 실패"로 묶지 말고, 인증 발급·gateway 검증·권한 결정·resource 접근 중 어느 단계에서 나온 것인지 기록합니다. token을 응답 artifact에 남기지 않도록 request header와 trace의 마스킹 규칙을 테스트합니다.

## 성능 예산을 설정하는 방법

synthetic check의 latency 기준은 임의의 2초 같은 숫자보다 사용자와 시스템의 기대에서 시작합니다. 로그인 redirect가 평소 300ms인데 10초로 늘어났지만 timeout 전이라 통과 처리하면, 고객은 이미 느린 서비스를 경험할 수 있습니다. 반대로 멀리 떨어진 region에서 2초가 걸렸다는 이유로 즉시 page하면 지역 network 편차에 과민해질 수 있습니다. region·check 종류·업무 중요도별 baseline과 경고·심각 임계값을 다르게 둡니다.

percentile 개념도 유용합니다. 모든 check의 평균은 몇 번의 매우 느린 결과를 숨길 수 있고, 단일 최대값은 일시적인 잡음에 흔들릴 수 있습니다. 일정 기간의 p95 또는 p99, 연속 실패, 최근 deploy 이후 변화처럼 여러 신호를 함께 보면 추세를 더 잘 판단할 수 있습니다. 하지만 표본이 적은 browser journey에서 percentile 숫자를 과신하면 안 됩니다. check 횟수, location, runner 성능, 실제 사용자 RUM과의 차이를 함께 보세요.

성능 check는 부하 테스트가 아닙니다. 일정 주기의 한두 요청으로 peak traffic에서의 capacity, queue saturation, rate limit을 증명할 수 없습니다. synthetic latency가 악화되면 성능 회귀의 조기 신호로 조사하고, release 전 용량 검증이 필요하면 별도의 load test와 resource 관찰을 실행합니다. 서로 다른 목적의 측정을 하나의 성공 숫자로 합치지 않는 것이 중요합니다.

## 비용과 실행 빈도의 균형

browser runner, 여러 global location, screenshot·trace 저장, 외부 sandbox 호출은 모두 비용과 quota를 사용합니다. 그래서 모든 journey를 1분마다 모든 region에서 실행하는 방식은 지속 가능하지 않을 수 있습니다. service criticality에 따라 계층을 둡니다. DNS·HTTP availability는 짧은 주기로 여러 location에서, 로그인·검색은 중간 주기로, 결제 직전 또는 관리자 변경은 더 긴 주기나 deploy 뒤에 실행하는 식입니다.

실행 빈도를 줄일 때는 탐지 시간과 고객 영향의 trade-off를 기록합니다. 30분마다만 실행하는 관리자 승인 check는 그 기능의 장애를 늦게 발견할 수 있지만, 실제 사용 빈도가 낮고 사람 검토가 있는 업무라면 수용할 수 있습니다. 반대로 public login은 몇 분의 실패도 많은 고객에게 영향을 줄 수 있어 더 짧은 주기와 다중 location이 필요할 수 있습니다. 비용 절감은 무작정 check를 끄는 일이 아니라 중요도에 맞춰 신호의 해상도를 조정하는 일입니다.

## 접근성·호환성 신호와의 연결

browser journey는 보이는 버튼을 누르는 것만 확인하기 쉽지만, keyboard navigation, focus 이동, screen reader label, color contrast 같은 접근성 요구를 매번 synthetic monitor가 완전히 검증하지는 않습니다. 별도의 접근성 test와 정적 검사, 실제 사용자 테스트가 필요합니다. 다만 핵심 로그인과 결제 여정에서 role·label 기반 selector를 사용하면, 최소한 접근 가능한 이름이 사라져 journey가 실패하는 일부 회귀를 빨리 발견할 수 있습니다.

browser engine도 한 종류만 쓰면 특정 엔진의 호환성 문제를 놓칠 수 있습니다. 모든 synthetic check를 모든 browser에서 실행하는 비용이 과하다면, 주요 고객 분포와 위험에 맞춰 대표 browser를 정하고 release candidate에서 호환성 suite를 별도로 둡니다. 모바일 web, embedded browser, 오래된 enterprise browser처럼 제품에 중요한 환경은 user-agent만 흉내 내는 것보다 실제 테스트 전략을 마련해야 합니다.

## 변경 관리와 check 소유권

synthetic script는 production을 호출하는 코드입니다. application route가 바뀌거나 UI가 재설계됐는데 script owner가 모르면 false alert가 생기고, script를 급히 고쳐 오류를 숨길 수도 있습니다. check를 어떤 서비스·여정의 일부로 볼지 owner를 정하고, application 변경 pull request에서 영향을 받는 monitor를 검토합니다. script 자체도 code review, dependency update, secret scan, 테스트 환경 실행을 거칩니다.

check를 제거할 때도 이유가 필요합니다. 기능이 폐기됐는지, 중복 신호인지, 다른 check로 대체됐는지, owner가 없는지 확인합니다. 알림이 시끄럽다는 이유만으로 monitor를 삭제하면 실제 고객 영향이 보이지 않는 공백이 생길 수 있습니다. 반대로 오래된 test account와 route를 계속 점검하면 비용과 노이즈가 늘어납니다. inventory와 마지막 성공·실패·owner·목적을 정기적으로 검토하면 monitor suite가 제품과 함께 진화합니다.

## incident 뒤 check를 개선하는 방법

실제 incident가 끝난 뒤에는 "왜 monitor가 못 잡았는가"와 "왜 monitor가 너무 늦거나 시끄러웠는가"를 함께 봅니다. 고객이 checkout에서 실패했는데 synthetic check가 상품 상세까지만 봤다면, 부족한 경계를 명확히 하고 안전한 test fixture로 다음 단계를 추가할 수 있습니다. 반대로 test account lock 때문에 page가 발생했는데 실제 고객은 정상이라면, 계정 lifecycle과 alert 분류를 개선합니다. 실패 사건을 무조건 새 check 수로 해결하지 말고, 어떤 신호가 의사결정에 필요했는지부터 확인합니다.

check를 추가하면 다른 신호와 중복되는지도 봅니다. 이미 API metric과 browser journey가 같은 outage를 충분히 탐지한다면, 세 번째 유사 check보다 runbook과 artifact 연결을 개선하는 편이 더 낫습니다. 새 check의 owner, 목적, 실행 주기, alert severity, test data, 제거 조건을 기록하면 시간이 지난 뒤에도 왜 존재하는지 설명할 수 있습니다. monitor suite는 기능 목록이 아니라 incident 대응 능력을 유지하는 제품입니다.

## 서비스 경계별 적용 판단

정적 marketing page는 DNS·TLS·주요 asset·form 제출을 확인하는 비교적 작은 check로 시작할 수 있습니다. 인증된 SaaS는 로그인·권한·핵심 조회·결제 준비처럼 더 넓은 journey가 필요할 수 있습니다. 내부 batch 시스템은 화면보다 job 시작·입력 파일 수신·결과 생성·다운스트림 전달을 synthetic 또는 canary data로 확인하는 편이 맞을 수 있습니다. 같은 도구를 쓰더라도 사용자 목표와 실패 영향이 다르면 성공 조건과 alert가 달라집니다.

아직 사용자가 없는 새 기능에 많은 global browser check를 먼저 만들 필요는 없습니다. 대신 release validation에서 안전한 test account로 핵심 흐름을 확인하고, 사용량·위험이 늘면 주기와 location을 확장합니다. 반대로 이미 매출·권한·고객 지원에 중요한 경로라면 "나중에 monitor를 붙이자"고 미루지 말고 출시 조건에 포함합니다. 적용 범위는 기능의 인기도가 아니라 실패했을 때 늦게 알면 안 되는 이유에서 결정합니다.

## 점검 설계를 문서로 남기기

각 synthetic check에는 한 장의 짧은 설명이 있으면 충분합니다. 사용자 목표, 시작 URL 또는 API, 전용 계정·fixture, 성공 assertion, 실행 location과 주기, 알림 수신자, 실패 artifact 위치, maintenance 중 처리, 제거 조건을 적습니다. 이 정보가 없으면 담당자가 바뀔 때 script는 남아도 왜 중요한지 알 수 없고, alert가 울렸을 때 누가 대응해야 하는지도 모호해집니다.

문서는 실제 script와 같이 변경합니다. URL이나 selector를 바꾸고 문서를 안 고치면 runbook이 오래된 화면을 가리키고, test account 권한을 바꾸고 alert 정책을 안 고치면 정상 check가 거짓 실패를 냅니다. 작고 정확한 문서가 큰 위키보다 유용한 이유는 배포와 incident에서 바로 확인할 수 있기 때문입니다.

## 최소 시작 체크리스트

첫 synthetic monitor를 만들 때는 1) 실제 고객에게 중요한 여정 하나를 고르고, 2) production과 분리된 test data·account를 준비하고, 3) 성공과 실패의 명확한 assertion을 정하며, 4) 실패 artifact의 민감정보를 마스킹하고, 5) 누구에게 언제 알려 줄지 정하고, 6) 실제 사용자 신호와 비교할 dashboard를 연결합니다. 이 여섯 가지가 갖춰지면 화려한 browser script보다 먼저 운영 가능한 신호를 만들 수 있습니다.

check가 처음부터 완벽할 필요는 없습니다. 가장 큰 사용자 위험 하나를 안전하게 발견하는 check를 먼저 신뢰할 수 있게 만들고, incident와 release 경험을 바탕으로 범위·location·assertion을 늘립니다. 성공률이 높은 script보다 실패했을 때 원인을 설명하고 행동으로 연결되는 script가 더 가치 있습니다.

운영 중에는 check의 성공 기록뿐 아니라 실패 후 대응 시간이 줄었는지도 돌아봅니다. 탐지·진단·복구의 연결이 좋아질수록 synthetic monitor는 단순한 알림을 넘어 서비스 신뢰성을 높이는 도구가 됩니다.

정기 review에서 필요 없는 check를 정리하고 중요한 여정을 보강하면 신호의 품질도 유지됩니다.

무엇을 보지 못하는지도 함께 적어 두면, 통과 결과를 과신하지 않고 다음 개선의 우선순위를 정할 수 있습니다.

## 업무 예시: 로그인과 주문 시작 여정

온라인 주문 서비스가 있다고 가정합니다. 팀은 1분마다 외부 location에서 홈 페이지의 DNS·TLS·HTTP 상태를, 5분마다 전용 test account로 로그인해 주문 목록을 조회하는 browser journey를, 10분마다 sandbox 결제 수단으로 checkout 직전까지 가는 제한된 journey를 실행합니다. 결제 확정은 하지 않거나, sandbox의 idempotency key와 cleanup job으로 test order가 쌓이지 않게 합니다.

로그인 journey가 실패했을 때는 먼저 홈 page check와 profile API check를 비교합니다. 홈과 API가 정상이고 browser만 실패하면 redirect, cookie, CSP, JavaScript bundle, selector를 봅니다. API도 401이면 token 발급 또는 identity provider를 조사합니다. 여러 location의 DNS check가 같이 실패하면 DNS provider나 certificate chain을 먼저 봅니다. 이 분리는 한 번의 UI 실패를 전체 서비스 장애로 과장하거나, 반대로 고객 로그인 실패를 frontend test 문제로 축소하는 일을 막습니다.

배포 직후에는 check 결과와 실제 로그인 성공률, error log, support ticket을 함께 봅니다. synthetic login이 성공해도 특정 브라우저·국가·고객 계정만 실패할 수 있고, 실제 고객 오류가 높아도 test account의 권한과 데이터가 달라 정상일 수 있습니다. monitor는 정답이 아니라 조사 시작점입니다. 서로 다른 신호가 어긋날 때 그 차이를 설명하는 것이 운영 품질을 높입니다.

## 한계와 적용 기준 Q&A

### Q. Synthetic Monitoring이 통과하면 서비스는 정상인가요?

A. 대표 계정·지역·브라우저·fixture에서 정한 여정이 성공했다는 뜻입니다. 실제 고객의 네트워크, 권한, 데이터, 기기, 외부 dependency까지 모두 대표하지는 않습니다. 실제 사용자 지표, 오류 로그, 지원 문의와 함께 해석해야 합니다.

### Q. production에서 write 동작을 전혀 점검하면 안 되나요?

A. 반드시 금지되는 것은 아니지만, 실제 금전·알림·데이터를 바꾸는 작업은 위험합니다. sandbox, test tenant, idempotency key, 보상·cleanup, 제한된 권한, 승인된 일정이 있을 때만 검토하세요. 읽기 check와 되돌릴 수 있는 단계로 목적을 달성할 수 있다면 그쪽이 더 안전합니다.

### Q. check 주기를 짧게 하면 더 좋은가요?

A. 더 빨리 탐지할 수 있지만 비용·rate limit·test data 충돌·오경보가 늘 수 있습니다. 핵심 availability check는 짧게, 브라우저 여정과 외부 sandbox 의존 check는 위험과 비용에 맞는 주기로 정하세요. 주기보다 실패 뒤 누가 어떤 행동을 하는지가 더 중요합니다.

### Q. synthetic 계정의 비밀번호를 CI secret에 두면 충분한가요?

A. secret 저장은 출발점일 뿐입니다. 최소 권한을 주고, rotation·만료·MFA 예외 정책·로그 마스킹·계정 잠금 대응을 정해야 합니다. 실제 직원 계정이나 공유 관리자 계정을 monitor에 쓰지 않는 편이 안전합니다.

## 마무리

Synthetic Monitoring은 성공률을 보기 위한 자동 브라우저가 아니라, 중요한 사용자 약속이 지금도 수행되는지를 외부에서 확인하는 운영 신호입니다. 작은 availability check와 대표 journey를 층으로 나누고, 안전한 test data와 행동 가능한 alert·artifact·runbook을 함께 설계하세요. 그러면 배포가 없는 시간에도 발생하는 DNS, 인증, UI, 외부 의존성 문제를 더 빨리 발견하고 실제 사용자 신호와 연결해 대응할 수 있습니다.

<h3 class="references-heading">참고 자료</h3>

- [Google SRE Book: Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/)
- [Google SRE Workbook: Probing and Alerting on Services](https://sre.google/workbook/alerting-on-slos/)
- [Playwright: Best Practices](https://playwright.dev/docs/best-practices)
- [OpenTelemetry: Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/)
