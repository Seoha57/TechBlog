---
layout: post
title: "Tibero 사용자와 권한을 설계하는 법: 인증·Role·Object Privilege·운영 계정의 경계"
category: DBA
description: "Tibero에서 사람·애플리케이션·운영 자동화의 계정을 분리하고, 역할과 객체 권한을 최소 권한 원칙으로 운영하는 사고방식과 점검 기준을 정리합니다."
---

<section class="quick-answers"><h2>먼저 답하기</h2><p><strong>Q. 애플리케이션 계정 하나에 필요한 권한을 모두 주면 관리가 더 쉽지 않나요?</strong><br>A. 처음에는 편하지만, 유출·오작동·배포 실수의 영향 범위가 커지고 누가 어떤 작업을 했는지 추적하기 어려워집니다. 읽기·쓰기·배치·스키마 변경·운영 관리를 책임 단위로 나눠야 합니다.</p><p><strong>Q. Role만 잘 만들면 최소 권한이 보장되나요?</strong><br>A. Role은 권한 묶음을 관리하는 좋은 수단이지만, 어떤 객체에 어떤 작업이 필요한지와 실행 경로를 먼저 알아야 합니다. broad system privilege, 공유 계정, 기본 Role, 우회 가능한 운영 절차가 남으면 Role 이름만으로는 안전하지 않습니다.</p></section>

데이터베이스 권한은 보안 담당자만의 설정값이 아닙니다. application이 어떤 테이블을 읽고 쓰는지, 배치가 실패했을 때 무엇을 재처리할 수 있는지, migration 도구가 어느 시간에 어떤 DDL을 실행하는지, 운영자가 장애에서 어떤 정보를 조회할 수 있는지를 결정하는 운영 계약입니다. 권한이 너무 넓으면 한 계정의 오류가 많은 데이터에 퍼지고, 너무 좁으면 배포나 장애 대응 때마다 임시 권한을 추가하다 예외가 쌓입니다. 좋은 설계는 "권한을 적게 준다"는 구호가 아니라 필요한 업무와 경계를 설명할 수 있게 만드는 일입니다.

Tibero를 포함한 관계형 데이터베이스는 사용자, role, system privilege, object privilege, schema라는 개념으로 이 계약을 표현합니다. 제품별 문법과 관리 도구에는 차이가 있지만, 사람과 program을 구분하고, 데이터 객체별 권한을 좁히고, 높은 권한은 짧고 추적 가능한 경로로 제공한다는 원칙은 같습니다. 이 글은 특정 조직의 운영 규칙을 대신하지 않습니다. 새 서비스나 기존 Tibero 인스턴스에서 계정을 정리할 때 어떤 질문을 해야 하는지에 초점을 둡니다.

## 먼저 알아둘 기반 기술

인증(authentication)은 접속한 주체가 누구인지 확인하는 과정입니다. password, 외부 identity provider, 인증서, 운영망 접근 통제 등이 여기에 속합니다. 인가(authorization)는 확인된 주체가 무엇을 할 수 있는지 결정하는 과정입니다. 비밀번호를 안전하게 보관해도 그 계정이 모든 테이블을 삭제할 수 있다면 인가 설계는 넓습니다. 반대로 권한이 정교해도 여러 사람이 같은 ID와 password를 공유하면 누가 실행했는지 인증과 감사가 약해집니다. 두 문제는 연결되어 있지만 서로 바꿔 해결할 수 없습니다.

사용자(user)는 database에 접속하는 identity이고, schema는 보통 그 사용자가 소유하는 객체의 논리적 이름 공간입니다. 예를 들어 `ORDER_APP` schema가 주문 테이블을 소유하고, 별도 application user가 필요한 객체 권한만 받아 접속할 수 있습니다. 모든 application 계정이 각자 테이블을 소유하게 만들면 ownership과 실행 권한이 섞이고 migration의 책임이 모호해집니다. 반대로 schema owner를 application runtime으로 겸하면, 취약점이 실행 권한을 넘어 구조 변경 권한으로 이어질 수 있습니다.

object privilege는 특정 table, view, sequence, procedure 같은 객체에 대한 `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `EXECUTE` 권한처럼 좁은 권한입니다. system privilege는 사용자 생성, 객체 생성, 광범위한 dictionary 조회처럼 database 수준 동작을 허용합니다. system privilege는 편리하지만 영향 범위가 넓습니다. runtime application이 새 테이블을 만들 필요가 없는 경우, 업무가 급하다는 이유로 broad system privilege를 주는 대신 필요한 schema의 특정 객체 권한을 부여하는 편이 나중에 검토하기 쉽습니다.

Role은 권한을 이름 있는 묶음으로 관리하는 방법입니다. 예를 들어 `ORDER_READONLY`, `ORDER_WRITER`, `ORDER_BATCH_EXECUTOR`처럼 업무 역할에 맞춘 Role을 만들면 같은 종류의 계정을 일관되게 관리할 수 있습니다. 하지만 `DBA`, `APP_ALL`, `TEMP_ADMIN`처럼 의미가 넓은 Role은 실제 권한을 가릴 수 있습니다. Role 이름은 사람이 읽는 설명일 뿐이므로, 정기 점검에서는 Role이 포함한 system privilege와 object privilege, 이를 받은 사용자, 활성화 방식까지 확인해야 합니다.

감사(auditing)는 누가 언제 어떤 객체에 어떤 작업을 했는지 남기는 활동입니다. 모든 SQL 원문을 무제한으로 저장하는 것만이 감사는 아닙니다. 접속 성공·실패, 권한 변경, DDL, 민감 객체 조회, 높은 권한 사용처럼 조사 가치가 큰 이벤트를 선택하고, 보존 기간과 열람 권한을 정하는 것이 중요합니다. 감사 로그에는 개인정보나 business data가 들어갈 수 있으므로, 로그를 볼 수 있는 사람의 권한도 database 객체 권한만큼 신중하게 설계해야 합니다.

## 계정 종류를 먼저 분리하기

계정 설계가 어려워지는 이유는 하나의 ID에 서로 다른 책임을 넣기 때문입니다. 사람이 SQL client로 조회하는 계정, web application의 request를 처리하는 계정, 야간 정산 batch, schema migration 도구, backup·monitoring 자동화는 필요한 권한과 실행 시간, password 교체 방법, 감사 요구가 다릅니다. 이름 하나를 공유하면 편해 보이지만, 장애 시 어떤 프로그램이 데이터를 바꿨는지 알기 어렵고 한 경로의 비밀 노출이 모든 경로를 위험하게 만듭니다.

첫째, schema owner는 DDL과 객체 ownership의 책임을 갖는 계정으로 분리합니다. table·index·view·procedure를 만들고 바꾸는 권한은 runtime보다 넓을 수 있으므로, 일반 application server의 환경 변수에 이 계정의 password를 두지 않는 편이 좋습니다. migration은 CI/CD의 제한된 job 또는 승인된 운영 절차에서만 owner나 제한된 deploy role을 사용하게 합니다. 객체 생성이 필요한 배포와 일상 request 처리를 같은 ID로 하지 않으면, SQL injection이나 application bug가 schema 변경으로 번질 가능성을 줄일 수 있습니다.

둘째, runtime 계정은 서비스별·업무별로 나눕니다. 주문 API가 `orders`, `payments`, 필요한 sequence만 쓰고, 검색 API는 읽기 전용 view만 보도록 하면 한 서비스의 오류가 다른 도메인 데이터까지 바꾸기 어렵습니다. 하나의 monolith라도 읽기 트래픽, back-office 수정, 정산 batch처럼 위험과 책임이 다른 작업은 계정을 나눌 이유가 있습니다. 분리가 너무 세밀해 connection pool과 credential 관리가 복잡해진다면, 도메인·실행 주체·쓰기 영향이 큰 경계부터 시작합니다.

셋째, 사람의 조회 계정은 application 계정과 분리합니다. 개발자나 지원 담당자가 production 데이터를 확인해야 하는 경우에도 application의 쓰기 권한을 그대로 사용하지 않습니다. 필요한 column만 포함한 view, 마스킹된 view, read-only role, 승인된 bastion·query tool을 조합할 수 있습니다. 조회 목적과 수정 목적을 분리하면 사고 조사와 고객 지원은 가능하게 유지하면서도, 실수로 production row를 바꾸는 위험을 줄입니다.

넷째, 운영 자동화 계정은 사람이 직접 로그인하는 ID와 구분합니다. monitoring agent는 health와 성능 지표를 읽을 수 있어야 하지만 application table을 수정할 필요는 없습니다. backup job은 backup 관련 작업과 상태 조회가 필요할 수 있지만 사용자 생성 권한이 필요하지 않을 수 있습니다. automation에 필요한 비밀은 secret manager나 접근 제어된 배포 설정에서 주입하고, 콘솔·문서·채팅에 평문으로 남기지 않습니다. password rotation 때 어떤 job이 영향을 받는지도 계정별로 파악할 수 있어야 합니다.

## 객체 권한을 업무 흐름으로 번역하기

권한 목록을 만들 때 table 이름만 보지 말고 데이터 흐름을 따라갑니다. 주문 API가 주문을 생성할 때 `orders`에 insert하고, 결제 상태를 update하고, `order_events`에 event를 append하며, sequence에서 ID를 얻는다고 가정해 보겠습니다. 이 흐름을 문서화하면 필요한 권한은 `orders` 전체에 대한 모든 권한이라는 뭉뚱그린 답이 아니라, 특정 객체와 operation의 목록이 됩니다. `DELETE`는 환불 처리에 정말 필요한지, soft delete update로 대체하는지, event table은 insert만 허용해야 하는지 질문할 수 있습니다.

view는 데이터 노출 범위를 줄이는 유용한 경계입니다. support 도구가 주문 상태와 고객 식별자 일부만 필요하다면, 원본 테이블 전체 대신 필요한 column과 row 조건을 가진 view를 제공합니다. 이 방식은 application 코드에 마스킹 규칙을 중복하기보다 database에서 공통 경계를 유지하는 데 도움이 됩니다. 다만 view가 모든 row-level security 요구를 자동으로 해결하는 것은 아닙니다. 사용자별 tenant 범위가 다르거나 business rule이 복잡하면 application authorization과 database 조건이 일관되게 동작하는지 별도로 검증해야 합니다.

stored procedure나 package를 사용하는 경우에는 table 권한을 직접 넓히는 대신, 정해진 업무 동작에만 `EXECUTE`를 주는 방식도 고려할 수 있습니다. 예를 들어 잔액 이체가 여러 table의 update와 검증을 묶어야 한다면, application이 각 table에 직접 쓰기 권한을 얻는 것보다 검증된 procedure를 호출하게 하는 편이 규칙을 한곳에 둘 수 있습니다. 그러나 procedure owner의 권한, dynamic SQL, 입력 검증, 오류 처리, 배포 검토가 약하면 권한을 감싼 것처럼 보여도 우회 경로가 생길 수 있습니다. procedure는 보안 도구이면서 동시에 코드이므로 일반 application 변경처럼 테스트하고 review해야 합니다.

sequence와 trigger도 자주 빠뜨리는 객체입니다. 새 row를 만들 때 sequence 접근이 필요한지, trigger가 다른 table에 audit row를 쓰는지, application이 직접 ID를 만들 수 있는지를 확인하지 않으면 배포 뒤 권한 오류가 납니다. 이 오류를 해결하려고 전체 schema 권한을 주면 원래 설계한 경계가 사라집니다. 테스트 환경에서 실제 runtime user로 create·update·rollback·batch 재처리를 실행해 필요한 객체 권한을 확인하는 편이 안전합니다.

## 구체적 업무 예시: 주문 서비스의 세 가지 실행 주체

주문 서비스를 `ORDER_OWNER`, `ORDER_API`, `ORDER_SETTLEMENT` 세 주체로 나눠 보겠습니다. `ORDER_OWNER`는 schema와 migration을 담당합니다. 이 계정은 table·index·view·procedure의 구조를 바꾸지만 application server에는 배포되지 않습니다. migration pipeline은 change ticket, 검토된 script, 실행 시간 창을 갖고 이 계정을 사용하며, 실행 결과와 schema version을 남깁니다. DDL 실패가 일어나도 request traffic을 처리하는 `ORDER_API`의 credential을 바꿀 필요가 없다는 장점이 있습니다.

`ORDER_API`는 주문 생성·조회·취소 같은 online request만 처리합니다. 필요한 table에는 select·insert·update를 받되, 정산 원장이나 운영 감사 테이블의 delete·alter 권한은 받지 않습니다. customer support가 주문을 조회하는 endpoint도 별도 view나 API를 통해 제한된 데이터를 보도록 합니다. 만약 API 서버가 침해되거나 잘못된 SQL이 배포돼도, 피해 범위는 이 계정이 갖는 도메인 객체와 operation 안에 머뭅니다. 이 경계는 완전한 방어가 아니라 영향 범위를 줄이는 방법입니다.

`ORDER_SETTLEMENT`는 야간 정산 batch 전용입니다. 이 계정은 일정 기간의 확정 주문을 읽고, 정산 결과를 append하며, 이미 처리한 건을 다시 처리하지 않기 위한 상태를 갱신합니다. online API와 분리하면 batch의 긴 transaction·lock·resource 사용이 request path와 섞이는 것을 줄일 수 있고, 감사에서도 낮 시간의 API 변경과 야간 batch 변경을 구분할 수 있습니다. 정산 계정이 필요 이상으로 주문을 삭제하거나 사용자 정보를 수정할 수 없게 하면, batch script의 실수도 제한됩니다.

세 계정에 대한 테스트는 단순 접속 성공만으로 끝나지 않습니다. `ORDER_API`로 migration DDL이 실패하는지, `ORDER_SETTLEMENT`로 지원용 view를 읽지 못하는지, `ORDER_OWNER` password가 runtime configuration에 포함되지 않는지 확인합니다. 정상 업무 흐름과 거절돼야 하는 흐름을 같은 테스트 목록에 두면 최소 권한이 기능 장애를 만들지 않는지, 반대로 편의를 위해 경계가 풀리지 않는지 함께 확인할 수 있습니다.

## 높은 권한과 긴급 접근을 다루는 법

장애 시에는 넓은 권한이 필요할 수 있습니다. connection 수가 고갈됐거나 storage가 부족하거나 잘못된 권한 변경을 되돌려야 하면, 일반 runtime 계정으로는 조사와 복구가 불가능합니다. 이 사실이 평소에 높은 권한 계정을 공유해야 한다는 뜻은 아닙니다. 긴급 접근(break-glass)은 필요한 사람이 필요한 시간에만 높은 권한을 얻고, 사용 이유와 실행 기록을 남기며, 작업 뒤 권한이 자동 또는 수동으로 회수되는 절차입니다.

실무에서 중요한 것은 이름이 거창한 break-glass 계정을 만드는 것이 아니라 절차가 실제로 작동하는지 확인하는 것입니다. 누가 승인을 하는지, 담당자가 부재하면 어떻게 하는지, password나 token은 어디서 얻는지, 접속 로그와 SQL 감사는 남는지, 작업 후 어떤 사람이 검토하는지를 runbook에 적습니다. 분기에 한 번 정도 비운영 환경에서 절차를 연습하면, 실제 incident에서 비밀을 채팅으로 전달하거나 모두에게 DBA 권한을 주는 급한 선택을 줄일 수 있습니다.

높은 권한을 사용한 뒤에는 원인과 후속 조치를 분리합니다. 장애를 복구하려고 임시 role을 부여했다면, 왜 기존 권한으로는 진단할 수 없었는지와 그 role이 언제 제거되는지를 남깁니다. 영구 권한으로 바꾸기 전에 read-only diagnostic view, 더 좁은 system privilege, 별도 automation처럼 작은 해결책을 검토합니다. exception이 누적되면 원래의 최소 권한 설계는 문서에만 남게 됩니다.

## 권한 변경을 배포처럼 검증하기

권한은 application code와 별개로 바뀌지만, 실제로는 배포와 같은 위험을 가집니다. role에 privilege 하나를 추가하면 여러 사용자와 서비스에 즉시 영향을 줄 수 있고, revoke는 예상하지 못한 batch를 멈출 수 있습니다. 따라서 권한 변경도 schema migration처럼 version control, reviewer, 변경 사유, 적용 환경, rollback을 갖추는 편이 좋습니다. production 콘솔에서 직접 수정한 뒤 기억에 의존해 문서를 고치는 방식은 시간이 지날수록 현재 상태와 설계 의도를 어긋나게 만듭니다.

권한 변경 PR에는 최소한 대상 user·role, 추가 또는 제거할 privilege, 필요한 업무 흐름, 영향받는 서비스, 테스트 방법, rollback 방법을 적습니다. "권한 오류가 나서 추가"라는 설명만으로는 적절한 범위를 판단할 수 없습니다. 어떤 SQL 또는 endpoint가 실패했는지, object privilege로 해결할 수 없는 이유가 있는지, 대체 가능한 view나 procedure는 없는지를 확인해야 합니다. 변경을 검토하는 사람도 database 운영자만이 아니라 해당 데이터 owner와 application owner가 될 수 있습니다.

테스트에서는 positive case와 negative case를 함께 둡니다. runtime user가 주문을 생성·조회할 수 있는지 확인하는 positive test만 있으면, 실수로 추가된 delete·DDL·다른 schema 접근을 발견하지 못합니다. 제한된 test user로 금지된 작업이 실패하는지, audit event가 남는지, role revoke 뒤 필요한 job만 명확하게 실패하는지를 확인합니다. 권한 테스트는 모든 SQL을 자동 생성할 필요는 없지만, 민감한 경계는 CI나 staging check로 반복할 수 있어야 합니다.

## 비밀 관리과 계정 수명 주기

최소 권한을 설계해도 password를 오래 쓰거나 여러 설정 파일에 복사하면 계정 경계는 약해집니다. application credential은 source code와 image에 넣지 않고, 접근 제어된 secret store 또는 배포 환경의 secret 주입 기능을 사용합니다. secret을 읽을 수 있는 CI job과 운영자가 누구인지도 점검합니다. database 권한을 줄였는데 secret 저장소 접근이 넓으면 결국 공격자는 더 높은 계정의 password를 얻을 수 있습니다.

rotation은 비밀번호를 정기적으로 바꾸는 행위만이 아닙니다. 새 credential을 발급하고 application이 이를 읽도록 전환하며, connection pool과 long-running batch가 새 연결을 만들 수 있는지 확인하고, 이전 credential을 회수하는 전체 흐름입니다. 두 credential이 겹치는 기간을 정하고, 실패 시 어느 버전으로 돌아갈지 준비하면 무중단에 가깝게 진행할 수 있습니다. rotation을 한 번도 연습하지 않은 계정은 정책상 만료일이 있어도 실제 장애에서 쉽게 우회됩니다.

퇴사·팀 이동·서비스 종료도 account lifecycle입니다. 사람의 개인 계정은 접근 권한을 즉시 재검토하고, 더 이상 쓰지 않는 application user와 role은 usage를 확인한 뒤 제거합니다. 삭제 전에 최근 접속·job 설정·connection string·감사 로그를 확인하지 않으면 숨어 있던 legacy process가 실패할 수 있습니다. 그래서 계정에는 owner와 용도를 남기고, owner가 없어진 계정은 정기 점검의 우선 제거 후보로 둡니다.

## 멀티 테넌트와 개인정보 조회 경계

하나의 Tibero database에 여러 고객 또는 여러 업무 조직의 데이터를 두는 서비스는 권한 설계를 더 세심하게 해야 합니다. schema를 고객마다 분리하는지, 공용 table에 tenant key를 두는지, database 인스턴스를 분리하는지는 비용·운영·성능·규제 요구에 따라 달라집니다. 어떤 방식이든 "application이 tenant ID를 필터링하니 database 권한은 하나면 된다"는 가정에는 위험이 있습니다. query 조건 하나가 빠지거나 관리용 기능이 잘못 구현되면 다른 고객 행을 조회·수정할 수 있기 때문입니다.

공용 table 구조라면 application authorization과 database 접근 경계가 서로 보완해야 합니다. runtime user가 모든 tenant row를 읽을 수밖에 없는 구조라면, service account는 고객 기능별로 더 좁히고 관리자 조회는 별도 endpoint와 승인 절차를 둡니다. 가능하다면 민감한 column을 view로 분리하고, 지원 담당자가 필요한 식별자·상태만 보게 합니다. tenant 조건을 자동으로 넣는 framework 기능이 있더라도, 관리자 도구·batch·ad hoc SQL처럼 framework 밖에서 실행되는 경로를 목록에 포함해야 합니다.

schema 분리는 ownership과 migration을 분명히 하는 장점이 있지만, schema가 늘면 role 부여·patch·backup·monitoring의 운영 비용이 커집니다. 반대로 공용 schema는 운영이 단순해 보이지만 data isolation을 application 규칙에 더 많이 의존합니다. 정답을 제품 기능으로만 결정하지 말고, 고객 수, 데이터 민감도, 지원 방식, migration 빈도, 장애 시 복구 범위를 함께 평가합니다. 데이터 분리 방식이 바뀌면 계정·role·감사 대상도 다시 설계해야 합니다.

개인정보 조회는 최소 권한을 가장 구체적으로 적용할 수 있는 영역입니다. 고객 지원이 본인 확인을 위해 email 일부와 주문 상태만 필요하다면, 전체 프로필 table의 모든 column을 주지 않습니다. 마스킹된 view나 별도 stored procedure로 필요한 결과만 반환하고, 조회 사유·ticket ID·사용자를 함께 감사할 수 있습니다. 개발자가 장애를 재현해야 할 때도 production raw data를 바로 내려받기보다 synthetic data, 마스킹된 sample, 승인된 일시 조회를 우선합니다. database user의 권한은 데이터 보호 정책을 실제 실행 경로로 바꾸는 도구입니다.

## 성능 조사 권한과 데이터 변경 권한을 분리하기

DBA와 개발자는 느린 SQL, lock, 실행 계획, 세션 상태를 조사해야 합니다. 이때 dictionary view나 monitoring view를 읽을 수 있는 권한이 필요할 수 있습니다. 그러나 성능을 조사한다는 이유로 모든 table의 data 변경 권한이나 모든 운영 명령을 부여할 필요는 없습니다. 진단용 role은 가능한 한 metadata·세션 상태·집계 지표에 집중하고, 실제 data correction이나 instance 설정 변경은 별도의 승인된 경로로 분리하는 편이 좋습니다.

예를 들어 support engineer가 특정 주문이 왜 pending인지 확인해야 한다면, 주문 상태와 최근 event·결제 provider 응답 코드의 요약을 보는 diagnostic view가 더 적합할 수 있습니다. 이 계정이 직접 원장 row를 update할 수 있으면, 조사와 수정의 경계가 사라집니다. 실제 correction이 필요한 경우에는 재현 가능한 script, 대상 row, 예상 결과, rollback 방법을 포함한 change 절차로 넘깁니다. 긴급 수정은 가능해야 하지만 일상 조회 경로가 변경 권한을 가진 기본값이 되어서는 안 됩니다.

성능 tuning에서도 같은 원칙이 적용됩니다. 통계 수집, index 생성, parameter 변경, session kill, SQL plan 관련 조치는 서로 위험 수준이 다릅니다. query를 읽고 실행 계획을 보는 권한, 특정 session을 종료하는 권한, database 전체 parameter를 변경하는 권한을 하나의 "performance role"로 묶으면 책임 범위가 너무 넓어집니다. 실제로 필요한 작업을 나누고, 높은 영향의 명령은 변경 창·승인·감사·사후 검증을 거치게 합니다.

이 분리는 문제 해결 속도를 무조건 늦추는 방식이 아닙니다. 평소에 diagnostic view, 표준 dashboard, 자주 쓰는 안전한 조회 query, escalation 경로를 준비하면 현장 엔지니어는 광범위한 DBA 권한을 요청하지 않고도 많은 문제를 분류할 수 있습니다. 권한이 없어서 일을 못 한다는 상황은 종종 필요한 정보가 어디에 있는지, 누가 의사 결정을 하는지 문서화되지 않은 문제이기도 합니다. 최소 권한과 좋은 관찰 도구는 같이 설계될 때 효과가 큽니다.

## 감사 로그를 조사 가능한 증거로 만들기

감사를 활성화해도 로그가 너무 많거나 맥락이 없으면 사건 조사에 도움이 되지 않습니다. login success·failure, user와 role 변경, grant·revoke, DDL, 민감 객체 접근, 긴급 계정 사용처럼 보안·운영상 의미가 큰 이벤트를 먼저 정합니다. 각 이벤트에는 database user, client 식별 정보, 시간, 대상 객체, 성공·실패 결과, 가능한 경우 change request나 application request ID를 연결합니다. 이 정보가 있어야 "누가 무엇을 했는가"를 추측하지 않고 확인할 수 있습니다.

하지만 audit log가 새로운 민감 데이터 저장소가 되지 않도록 주의해야 합니다. SQL text와 bind value를 그대로 남기면 주민번호·이메일·token·고객 메모가 로그에 들어갈 수 있습니다. 조사에 필요한 수준으로 SQL 형태나 객체명만 남기고, bind value는 마스킹하거나 별도 접근 통제를 적용하는 선택지를 검토합니다. 운영 로그를 중앙 시스템으로 보내는 경우에도 전송·저장·검색 권한·보존 기간·삭제 정책이 data classification과 맞아야 합니다.

감사는 탐지뿐 아니라 변경 검증에도 쓰입니다. role에 예상하지 못한 privilege가 추가됐는지, schema owner가 평소 runtime 시간에 로그인했는지, 사용 중지한 account가 계속 접속하는지 정기적으로 확인할 수 있습니다. 단순히 로그를 보관하는 것보다 기대하지 않은 패턴을 정의하고, 해당 패턴이 발견됐을 때 담당자에게 전달되는 흐름을 만드는 편이 중요합니다. 알림이 너무 많으면 무시되므로, 초기에는 높은 위험의 변경부터 시작해 정확도를 다듬습니다.

사고가 발생했을 때 audit log를 확인할 권한도 제한해야 합니다. 조사자는 필요한 시간 범위와 대상 사건만 볼 수 있게 하고, 감사 로그 열람 자체도 남깁니다. application 운영자, database 관리자, 보안 담당자가 모두 같은 권한을 가질 필요는 없습니다. 역할을 분리하면 조사 속도가 느려질 것 같지만, 사전에 역할·연락처·절차를 정해 두면 비밀 로그를 무분별하게 복사하는 위험보다 더 예측 가능한 대응이 가능합니다.

## 권한 설계를 지속적으로 점검하는 방법

최소 권한은 한 번의 migration으로 완성되지 않습니다. 새 API와 batch가 추가되고, table과 view가 바뀌며, 담당자가 이동하고, temporary exception이 남습니다. 그래서 분기 또는 반기 단위로 user·role·privilege inventory를 다시 만들고, owner 없는 계정, 장기간 접속하지 않은 계정, 예상보다 넓은 role, production에만 존재하는 수동 grant를 찾습니다. inventory는 보안 감사용 문서가 아니라 운영자가 현재 권한 구조를 이해하는 기본 지도입니다.

점검 결과는 한꺼번에 큰 revoke를 실행하기보다 위험과 사용 여부에 따라 나눕니다. 먼저 명백히 사용하지 않는 test account와 만료된 temporary role을 정리하고, 다음으로 runtime user가 실제 쓰지 않는 object privilege를 staging에서 제거해 봅니다. 마지막으로 broad system privilege나 공유 계정처럼 영향이 큰 항목은 application 변경·migration 방식·지원 절차를 함께 바꾸는 계획을 세웁니다. 삭제 전에 최근 audit와 job 설정을 확인하고 rollback 경로를 준비하는 이유는 권한도 서비스 의존성의 일부이기 때문입니다.

새로운 권한 요청은 단순 ticket 처리로 끝내지 않습니다. 요청한 역할, 대상 schema와 object, 필요한 operation, 실행 주체, 기간, business justification, 테스트 방법, owner를 받으면 같은 질문을 반복하지 않아도 됩니다. 기간이 있는 exception은 만료 전에 owner에게 재검토를 요청하고, 업무가 끝나면 자동 회수하거나 점검 대상에 올립니다. 이 흐름은 사람을 불편하게 하려는 것이 아니라, 긴급 상황의 편의가 영구적인 공격 표면이 되는 것을 막는 장치입니다.

조직 규모가 작다면 완벽한 IAM 플랫폼을 먼저 만들 필요는 없습니다. account 목록을 version-controlled 문서로 관리하고, role 변경을 PR로 검토하며, 월간 접속 이력과 권한 차이를 확인하는 것부터 시작할 수 있습니다. 중요한 것은 설정이 수동이냐 자동이냐보다, 현재 상태와 의도가 비교 가능하고 높은 권한 사용이 예외로 남는지입니다. 이 작은 습관이 쌓이면 Tibero 운영에서도 보안과 장애 대응의 균형을 잡기 쉬워집니다.

## 장애와 배포에서 권한 문제를 줄이는 협업 방식

권한 오류는 개발팀과 DBA 팀이 서로에게 넘기기 쉬운 문제입니다. 개발자는 배포가 막혔다고 넓은 grant를 요청하고, DBA는 최소 권한 원칙만 말하면 원인은 해결되지 않습니다. 더 빠른 방식은 실패한 업무 흐름을 함께 확인하는 것입니다. 어떤 application user가, 어떤 환경에서, 어떤 object와 operation에 실패했는지, 그 작업이 실제 요구사항인지, schema·view·procedure·배포 순서 중 어디에서 좁게 해결할 수 있는지를 같은 change 기록에 남깁니다.

배포 순서도 중요합니다. 새 table을 읽는 application을 먼저 배포하면 권한이 아직 없어 오류가 날 수 있고, privilege를 먼저 추가했다가 배포가 취소되면 불필요한 권한이 남습니다. schema migration, privilege migration, application rollout, smoke test, rollback의 순서를 정의하고 자동화 도구가 어떤 identity로 각 단계를 실행하는지 확인합니다. 특히 blue-green이나 canary 배포에서는 이전 버전과 새 버전이 잠시 같은 role을 사용하므로, revoke 시점이 두 버전을 모두 고려해야 합니다.

사고 대응에서도 권한은 복구를 방해하거나 보호하는 요소가 됩니다. on-call이 상태를 볼 diagnostic view, DBA에게 escalation할 기준, 긴급 write가 필요한 경우의 승인 경로, 변경 뒤 audit 확인 절차를 미리 두면 문제 상황에서 password를 공유하거나 임시 DBA 계정을 무기한 만드는 일을 줄일 수 있습니다. 권한 경계는 평상시 통제뿐 아니라 압박이 큰 상황에서도 안전한 선택을 가능하게 하는 운영 설계입니다.

## 한계와 적용 기준 Q&A

### Q. 서비스마다 database user를 만들면 connection pool이 너무 많아지지 않나요?

A. 무조건 서비스 단위로 쪼개는 것이 목적은 아닙니다. 같은 신뢰 경계와 같은 데이터 접근 패턴을 가진 구성 요소는 하나의 runtime user를 공유할 수 있습니다. 다만 online API, migration, 정산 batch, 지원 조회처럼 실행 주체와 위험이 다르면 분리할 가치가 큽니다. pool 수와 운영 복잡도를 측정하면서 가장 영향이 큰 경계부터 나누면 됩니다.

### Q. 개발 환경에서는 모든 권한을 줘도 괜찮나요?

A. production 데이터나 credential이 전혀 없고 개인 sandbox라면 편의를 위한 넓은 권한이 가능할 수 있습니다. 그러나 개발 환경의 설정이 staging·production에 복사되는 일이 흔하므로, schema owner와 runtime user 분리 같은 기본 구조는 가능한 한 일찍 맞추는 편이 좋습니다. 최소 권한 테스트가 production에서 처음 실패하면 배포 압박 때문에 예외가 영구화되기 쉽습니다.

### Q. 읽기 전용 계정은 안전하므로 감사가 필요 없나요?

A. 읽기에도 개인정보·영업 정보·보안 설정이 노출될 수 있습니다. 누가 어떤 범위의 데이터를 조회했는지, 비정상적으로 많은 조회가 있었는지 확인할 필요가 있습니다. 다만 모든 SELECT 원문을 저장하면 민감한 값이 로그에 쌓일 수 있으므로, 객체·사용자·시간·결과 상태 중심으로 필요한 감사 범위와 보존 정책을 설계해야 합니다.

## 도입 체크리스트

현재 database user를 사람, runtime, batch, migration, monitoring, emergency access로 분류하고 owner와 용도를 적습니다. 각 계정이 가진 system privilege·object privilege·role을 추출해 실제 업무 흐름과 비교합니다. broad privilege는 필요한 객체·operation·view·procedure로 대체할 수 있는지 검토하고, 권한 변경은 version control과 review를 거치게 합니다. 마지막으로 실제 runtime user로 정상 작업과 금지 작업을 테스트하고, 비밀 rotation·긴급 접근·계정 폐기의 runbook을 준비합니다.

Tibero 권한 설계의 핵심은 복잡한 role 체계를 만드는 데 있지 않습니다. 누가 어떤 책임으로 접속하고, 어떤 데이터에 어떤 동작이 필요하며, 높은 권한은 어떤 예외 절차에서만 쓰이는지를 드러내는 데 있습니다. 이 경계를 application 설계·배포·감사·장애 대응과 함께 관리하면 권한은 배포를 막는 설정이 아니라 데이터와 운영을 안전하게 만드는 계약이 됩니다.

<h3 class="references-heading">참고 자료</h3>

- [Tibero Documentation](https://docs.tibero.com/)
- [Oracle Database Security Guide: Privileges and Roles](https://docs.oracle.com/en/database/oracle/oracle-database/26/dbseg/configuring-privilege-and-role-authorization.html)
