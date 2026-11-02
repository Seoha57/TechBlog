---
layout: post
title: "PostgreSQL PgBouncer를 설계하는 법: 연결 풀·Pool Mode·세션 상태·용량과 장애 경계"
category: DBA
description: "PostgreSQL 앞단의 PgBouncer가 연결 수를 관리하는 방식, session·transaction pooling의 차이, 애플리케이션 세션 상태와 용량·장애 운영 기준을 정리합니다."
---

<section class="quick-answers"><h2>먼저 답하기</h2><p><strong>Q. PgBouncer를 앞에 두면 PostgreSQL 연결 수 문제는 자동으로 해결되나요?</strong><br>A. 아닙니다. client 대기열과 server 연결을 분리해 연결 생성 비용을 줄일 수 있지만, 긴 쿼리·잠금·느린 의존성·잘못된 pool 크기까지 빠르게 만들지는 못합니다.</p><p><strong>Q. transaction pooling이 항상 가장 효율적인가요?</strong><br>A. 연결 활용도에는 유리할 수 있지만, 세션 변수·임시 테이블·prepared statement·연결별 인증처럼 세션 지속성을 전제한 기능은 호환성을 먼저 확인해야 합니다.</p></section>

## 먼저 알아둘 기반 기술

PostgreSQL에서 애플리케이션의 연결 하나는 보통 database server의 backend process 하나와 연결됩니다. 새 연결을 만들 때는 TCP 연결, TLS 협상, 인증, backend 초기화, 메모리 할당이 일어납니다. 요청마다 연결을 새로 열고 닫으면 짧은 SQL보다 연결 준비 비용이 더 커질 수 있고, 동시 사용자가 많아지면 database가 처리할 backend 수와 메모리도 빠르게 늘어납니다.

connection pool은 애플리케이션이 자주 쓰는 연결을 미리 열어 두고 요청이 필요할 때 빌려 주는 구성입니다. 애플리케이션 라이브러리의 pool은 보통 하나의 프로세스 안에서 연결을 재사용합니다. PgBouncer는 애플리케이션과 PostgreSQL 사이에서 별도 process로 동작하는 외부 pooler입니다. 여러 애플리케이션 instance의 client connection을 받아 더 적은 수의 server connection에 배정할 수 있다는 점이 차이입니다.

transaction은 여러 SQL을 하나의 원자적 작업으로 묶는 단위입니다. `BEGIN` 뒤의 변경은 `COMMIT`될 때 확정되고 오류가 나면 `ROLLBACK`으로 되돌릴 수 있습니다. session은 한 클라이언트 연결이 유지되는 동안의 문맥입니다. `SET`으로 바꾼 설정, 임시 테이블, advisory lock, prepared statement처럼 transaction이 끝나도 남을 수 있는 상태가 session 상태입니다. PgBouncer의 pool mode를 이해하려면 이 둘을 먼저 분리해야 합니다.

## PgBouncer가 해결하는 문제와 해결하지 못하는 문제

웹 API가 30개 instance로 늘어나고 각 instance가 최대 20개의 database connection을 열면, 단순 계산으로 600개 연결이 database에 도달할 수 있습니다. 실제 동시에 SQL을 실행하는 요청은 이보다 훨씬 적을 수 있습니다. PgBouncer는 idle client를 직접 database backend에 하나씩 붙이는 대신, 실제 쿼리를 실행할 때만 제한된 server connection을 빌려 주어 연결 수와 생성 비용을 줄일 수 있습니다.

그러나 pooler는 쿼리를 더 빠르게 최적화하는 도구가 아닙니다. 느린 full scan, lock wait, deadlock, disk I/O 포화, 복제 지연, 외부 API를 기다리는 애플리케이션 transaction은 그대로 느립니다. 오히려 client가 많고 server pool이 작으면 대기열이 생겨 사용자 latency가 길어질 수 있습니다. PgBouncer 도입 전에는 “연결 생성이 병목인가”, “동시 실행 SQL이 database 용량보다 많은가”, “하나의 쿼리가 너무 오래 연결을 점유하는가”를 구분해야 합니다.

또한 PgBouncer는 database의 `max_connections`를 무한대로 늘리는 대체제가 아닙니다. PostgreSQL에는 autovacuum worker, replication connection, 관리 계정, batch job, migration 작업도 필요합니다. application pool 크기를 정할 때 이 연결을 빼지 않으면 장애 때 관리자가 접속할 여유조차 잃을 수 있습니다. database의 전체 연결 예산과 PgBouncer의 database별·user별 pool 한도를 같이 계산해야 합니다.

## 세 가지 Pool Mode를 구분하기

**session pooling**에서는 client가 접속한 동안 같은 server connection을 계속 사용합니다. 기존 애플리케이션이 연결마다 `SET`, temporary table, cursor, prepared statement를 쓰더라도 비교적 호환되기 쉽습니다. 다만 client가 idle이어도 server connection 하나를 점유하므로, 여러 짧은 요청을 가진 서비스에서 connection multiplexing의 이점은 작아질 수 있습니다.

**transaction pooling**에서는 transaction이 끝날 때 server connection을 pool로 돌려보냅니다. 다음 transaction은 다른 server connection에서 실행될 수 있습니다. 많은 짧은 transaction을 처리하는 stateless API에는 효율적일 수 있습니다. 하지만 transaction 밖에서 세션 상태에 의존하면 다음 요청에서 값이 사라지거나 다른 연결의 상태를 만나게 됩니다. 가장 효율적인 mode라는 이유만으로 바꾸면 예상하지 못한 기능 오류가 생길 수 있습니다.

**statement pooling**은 statement마다 connection을 돌려보내는 방식으로, transaction 안의 여러 statement가 같은 connection을 써야 하는 일반적인 업무 처리와 맞지 않는 경우가 많습니다. 애플리케이션이 explicit transaction을 사용하거나 ORM이 transaction 경계를 관리한다면 특히 주의해야 합니다. 시작 단계에서는 session 또는 transaction pooling의 차이를 이해하고, statement mode를 성능 숫자만 보고 선택하지 않는 편이 안전합니다.

## transaction pooling에서 깨지기 쉬운 가정

가장 흔한 문제는 세션 변수입니다. 애플리케이션이 연결을 빌린 뒤 `SET search_path`, `SET ROLE`, `SET TIME ZONE`, `SET statement_timeout`을 실행하고 다음 요청에서도 같은 설정이 남는다고 가정할 수 있습니다. transaction pooling에서는 그 다음 요청이 다른 server connection을 받을 수 있습니다. 요청별 설정이 필요하다면 transaction 안에서 `SET LOCAL`을 사용하고, transaction 종료 시 초기화된다는 성질을 이해해야 합니다.

임시 테이블도 같은 이유로 위험합니다. 한 요청에서 `CREATE TEMP TABLE`을 만들고 다음 요청에서 다시 읽는 흐름은 session을 유지한다는 가정을 갖습니다. transaction pool에서는 다른 backend로 바뀔 수 있으므로 테이블을 찾지 못하거나, 운 좋게 같은 connection을 받아서만 통과하는 불안정한 동작이 될 수 있습니다. 임시 테이블이 필요한 batch는 session pooling을 쓰거나, 영속 테이블과 명확한 작업 ID를 사용하는 설계를 검토합니다.

listen/notify, advisory lock, server-side cursor, connection-local prepared statement도 점검 대상입니다. 어떤 기능은 driver가 자동으로 사용해 개발자가 인식하지 못할 수 있습니다. 예를 들어 ORM이 prepared statement를 cache하거나 migration 도구가 세션 설정을 바꿀 수 있습니다. pool mode를 바꾸기 전에 애플리케이션 코드뿐 아니라 driver 옵션, ORM 설정, background job, 운영 script를 목록으로 만들어 compatibility test를 해야 합니다.

## 구체적 업무 예시: 주문 API와 batch 작업을 나누기

주문 조회와 주문 생성 API가 여러 Pod로 실행되고, 야간 정산 batch도 같은 PostgreSQL을 사용한다고 가정해 보겠습니다. API는 짧은 read/write transaction이 많고, batch는 큰 집계 쿼리와 임시 작업을 오래 수행합니다. 이 둘을 같은 PgBouncer pool과 같은 `default_pool_size`에 넣으면 batch가 많은 server connection을 오래 점유해 API 대기열을 키울 수 있습니다.

더 안전한 출발점은 database 또는 user별로 역할을 나누는 것입니다. API runtime 계정은 transaction pooling과 보수적인 pool size를 사용하고, batch 계정은 session pooling 또는 별도 제한으로 둡니다. API가 다 쓴 connection을 공유할 수 있어도, batch가 무제한으로 모든 connection을 차지하지는 못하게 합니다. 읽기 전용 조회와 관리자 작업도 같은 이유로 별도 예산이 필요할 수 있습니다.

테스트에서는 API 요청이 증가할 때 PgBouncer client 대기열, server active connection, PostgreSQL의 실행 중 query, lock wait, p95 latency를 함께 봅니다. batch를 시작했을 때 API의 오류율과 대기 시간이 어떻게 변하는지, pool timeout이 사용자에게 어떤 응답으로 나타나는지 확인합니다. 여기서 성공 기준은 connection 수가 낮아지는 것만이 아니라, 중요한 사용자 요청이 예측 가능한 시간 안에 처리되는 것입니다.

## 용량은 최대 연결 수가 아니라 동시 작업 수로 계산한다

pool size를 정할 때 “database가 500 connections를 허용하니 API에 500을 주자”는 계산은 위험합니다. 연결 하나마다 backend process와 작업 메모리가 필요하고, 동시에 실행되는 쿼리가 너무 많으면 CPU 경쟁, cache miss, disk I/O, lock 경합이 증가할 수 있습니다. 적은 수의 잘 관리된 동시 작업이 더 많은 연결보다 안정적인 경우가 흔합니다.

먼저 workload를 분류합니다. 빠른 index lookup이 대부분인지, 몇 초 이상 걸리는 report가 있는지, transaction 안에서 외부 HTTP 호출을 하는 나쁜 경로가 있는지, connection을 빌린 뒤 실제 SQL 전까지 오래 기다리는지 관찰합니다. 각 종류가 동시에 몇 개까지 허용되는지와 database CPU·memory·I/O의 여유를 바탕으로 server pool 예산을 정합니다. 이 예산은 load test와 production 관찰로 조정하는 가설이지, 모든 환경에 맞는 고정 숫자가 아닙니다.

client connection 수는 server connection 수보다 클 수 있지만 무한하면 안 됩니다. 대기열이 너무 길면 timeout 뒤 retry가 늘어나 database 부하가 더 커질 수 있습니다. client 쪽에도 request deadline, queue 상한, backpressure, 실패 응답 기준이 필요합니다. “잠시 기다리면 된다”는 요청과 “즉시 실패해 사용자에게 다시 시도하게 해야 한다”는 요청을 업무 중요도에 따라 구분해야 합니다.

## Timeout과 재시도를 함께 설계하기

PgBouncer에서 connection을 기다리는 시간과 PostgreSQL에서 query를 실행하는 시간은 다른 문제입니다. pool wait timeout은 사용 가능한 server connection이 나올 때까지의 대기이고, `statement_timeout`은 database가 SQL을 실행할 수 있는 최대 시간입니다. HTTP gateway의 전체 deadline, application connection acquire timeout, PgBouncer wait, database query timeout이 서로 모순되면 사용자는 오래 기다린 뒤 애매한 오류를 받게 됩니다.

예를 들어 HTTP 요청의 deadline이 3초인데 pool timeout이 10초면, client는 3초에 끊겼지만 서버 안의 요청은 계속 queue에서 기다릴 수 있습니다. 반대로 query가 정상적으로 5초 필요한 report에 1초 statement timeout을 두면 업무 기능을 사용할 수 없습니다. request 종류별 deadline을 정하고, 상위 계층이 먼저 포기한 작업을 하위 계층이 불필요하게 계속하지 않도록 timeout 순서를 설계합니다.

재시도도 모든 오류에 적용하지 않습니다. 읽기 전용 query의 transient network failure는 제한된 재시도가 가능할 수 있지만, commit 결과를 받기 전에 연결이 끊긴 쓰기 transaction은 이미 반영됐을 가능성이 있습니다. 이 경우 무조건 다시 실행하면 주문이나 결제가 중복될 수 있습니다. 업무 ID, idempotency key, 결과 조회 경로를 갖추고 “모호한 결과”를 별도로 처리해야 합니다. PgBouncer는 연결 재사용 도구이지 업무 중복을 해결하는 장치는 아닙니다.

## 장애 조치와 배포 때 확인할 것

database failover, PgBouncer restart, network partition, credential rotation, 애플리케이션 rolling deployment가 일어나면 연결은 한꺼번에 다시 열릴 수 있습니다. 이때 모든 Pod가 동시에 reconnect하면 새 primary나 PgBouncer를 과부하시키는 thundering herd가 생길 수 있습니다. connection lifetime에 jitter를 두고, 재시도에 exponential backoff와 최대 횟수를 두며, readiness check가 database가 열릴 때까지 traffic을 무작정 받지 않도록 합니다.

PgBouncer를 여러 instance로 운영한다면 application이 어느 endpoint로 연결하는지와 각 instance의 pool 분포도 봐야 합니다. load balancer가 client connection을 고르게 보내지 못하면 한 PgBouncer는 대기열이 길고 다른 하나는 idle일 수 있습니다. 모든 instance가 같은 database에 새로운 server connection을 열 수 있으므로, instance별 pool size를 합친 총량이 database 예산을 넘지 않는지도 계산합니다.

배포 검증에는 연결을 열 수 있다는 health check만 넣지 않습니다. 대표 read/write transaction, transaction 종료 후 세션 상태가 남지 않는지, pool timeout 시 오류 형식, 장애 뒤 reconnect 속도, 관리자 계정의 접속 여유를 확인합니다. migration처럼 긴 lock을 잡을 수 있는 작업은 API traffic이 적은 시간에 수행하고, 필요한 경우 PgBouncer의 pause·drain 절차와 rollback 방법을 문서화합니다.

## 보안과 권한의 경계

pooler를 두면 application과 PostgreSQL 사이에 인증·비밀값·network policy의 경계가 하나 더 생깁니다. PgBouncer 설정 파일의 database URL과 auth 설정에는 credential이 들어갈 수 있으므로 source repository에 직접 넣지 않고 secret 관리와 파일 권한을 적용해야 합니다. 로그와 admin console에도 연결 문자열, password, client address가 불필요하게 노출되지 않는지 확인합니다.

하나의 고권한 database user로 모든 API를 연결하면 PgBouncer가 있어도 최소 권한 원칙은 지켜지지 않습니다. 읽기 서비스, 쓰기 서비스, 정산 batch, migration 도구는 필요한 object와 권한이 다릅니다. 운영 단순성과 권한 분리 사이의 균형을 정하되, 최소한 사람이 쓰는 관리자 계정과 runtime 계정을 분리하고, application 오류가 schema 전체를 변경할 수 없게 하는 것이 좋습니다.

transaction pooling에서 사용자별 권한을 `SET ROLE`로 전달하려는 경우도 특히 신중해야 합니다. 요청마다 role을 정확히 설정하고 transaction이 끝나면 초기화되는지, 권한 없는 요청이 이전 connection의 상태를 이어받을 가능성은 없는지 test해야 합니다. 보안 문맥을 session에 암묵적으로 남기는 방식보다, application 인증과 database role·row-level policy가 어떤 책임을 갖는지 명시하는 설계가 더 검증하기 쉽습니다.

## 설정값은 서로 연결된 예산이다

PgBouncer 설정의 숫자를 독립된 튜닝 항목으로 보면 문제가 생깁니다. `max_client_conn`은 받을 수 있는 client connection의 상한이고, `default_pool_size`는 database와 user 조합에 허용하는 server connection 수의 기본값입니다. 여기에 database별 설정, user별 설정, reserve pool, PgBouncer instance 수가 더해집니다. 특정 값 하나를 크게 바꾸기 전에 실제로 database backend가 최대 몇 개까지 열릴 수 있는지와 모든 PgBouncer instance가 만들 수 있는 server connection의 합을 계산해야 합니다.

예를 들어 PgBouncer 두 대가 있고 각각 API 계정에 40개, batch 계정에 10개의 server connection을 만들 수 있다면 최대 100개가 database로 갈 수 있습니다. 여기에 관리자, migration, replication, autovacuum과 예비 여유를 더합니다. database `max_connections`가 120이라면 평상시에는 동작해도 장애 뒤 reconnect가 몰리는 상황에서 쉽게 한계에 닿을 수 있습니다. 수치는 서비스 수가 아니라 총량과 장애 시나리오로 검토해야 합니다.

reserve pool은 일시적인 burst를 흡수하는 데 도움이 될 수 있지만, 늘어난 연결이 database의 실제 처리량을 늘린다는 뜻은 아닙니다. reserve가 자주 사용된다면 기본 pool이 너무 작은지, 특정 작업이 connection을 오래 붙잡는지, 쿼리가 느린지 조사해야 합니다. 항상 reserve를 늘리는 방식은 대기 문제를 database 과부하 문제로 바꾸기 쉽습니다.

client가 pool에 오래 머무는 이유도 나눠 봅니다. connection을 얻지 못해 기다리는지, transaction이 길어 server를 반납하지 않는지, application이 connection을 빌려 놓고 외부 HTTP 응답을 기다리는지, 쿼리가 lock을 기다리는지에 따라 해결책이 다릅니다. PgBouncer 상태 화면의 대기 수만 보고 pool size를 키우기보다 PostgreSQL의 active query, lock wait, transaction age, application trace를 같이 봐야 합니다.

## 애플리케이션 pool과 이중 대기열을 피하기

대부분의 driver와 ORM은 자체 connection pool을 갖고 있습니다. application pool이 Pod마다 50개이고 PgBouncer의 server pool은 전체 30개라면, 부하가 높을 때는 application에서 한 번 기다리고 PgBouncer에서 다시 기다리는 이중 대기열이 생길 수 있습니다. 사용자 요청은 어디서 막히는지 알기 어렵고, 각 계층의 timeout이 다르면 취소된 요청이 하위 queue에 남을 수도 있습니다.

먼저 각 Pod의 동시 요청 수, application pool의 최대값, acquire timeout, idle timeout, PgBouncer client 제한, PgBouncer server pool, database timeout을 표로 만듭니다. 모든 숫자를 같게 맞추라는 뜻은 아닙니다. 다만 어떤 계층이 부하를 받아들이고 어느 계층이 거절할지 의도적으로 결정해야 합니다. API server가 너무 많은 요청을 database 대기열로 넘기기보다, 상위 계층에서 backpressure를 주고 사용자에게 재시도 가능한 오류를 주는 편이 나을 수 있습니다.

애플리케이션 pool을 없애는 것도 자동 정답은 아닙니다. process 내부에서 연결 생성과 사용을 제어하는 기능, health check, driver 특성을 고려해야 합니다. 중요한 것은 connection 하나가 어떤 계층에서 얼마나 오래 점유되는지 관찰하고, 각 계층이 같은 요청을 무한히 기다리지 않게 만드는 것입니다. pool을 여러 개 둔다면 owner와 한도, timeout, 모니터링 항목을 문서에 함께 남깁니다.

## 긴 transaction은 pool 문제처럼 보이는 업무 문제다

긴 transaction은 server connection을 오래 점유하고, lock을 오래 유지하며, vacuum과 복구에도 영향을 줄 수 있습니다. 흔한 원인은 transaction 안에서 파일 업로드, 외부 결제 호출, 사용자의 입력 대기, 대량 처리 루프를 수행하는 것입니다. PgBouncer가 연결을 공유해도 transaction이 끝날 때까지는 다른 client에게 server connection을 줄 수 없으므로, transaction pooling의 이점도 사라집니다.

긴 작업은 가능한 한 준비 단계와 database 변경 단계를 나눕니다. 외부 API 호출 결과를 먼저 안전하게 준비하고, 짧은 transaction 안에서 상태를 갱신하는 방식을 검토할 수 있습니다. 단, 외부 호출과 database 변경 사이에는 부분 실패가 생길 수 있으므로 outbox, idempotency key, 상태 조회 같은 별도 설계가 필요합니다. transaction을 짧게 하겠다는 이유로 업무 원자성을 함부로 포기하면 안 됩니다.

관찰할 때는 평균 transaction 시간만 보지 않습니다. 오래 열린 transaction의 개수와 나이, idle in transaction session, lock을 오래 기다리는 query, connection을 빌린 뒤 SQL을 실행하지 않는 시간, abort된 transaction 비율을 함께 봅니다. 특정 endpoint나 batch가 상위 목록에 반복되면 pool 크기보다 그 흐름의 transaction 경계를 먼저 고치는 편이 효과적일 수 있습니다.

## 준비된 문장과 driver 동작을 검증하기

prepared statement는 SQL parsing과 planning 비용을 줄일 수 있고 parameter를 안전하게 전달하는 데 사용됩니다. 그러나 server-side prepared statement는 특정 PostgreSQL session에 묶일 수 있습니다. transaction pooling에서는 다음 transaction이 다른 server connection을 받을 수 있으므로, driver가 prepared statement를 어떤 방식으로 cache하고 재준비하는지 확인해야 합니다. 이름 충돌이나 존재하지 않는 prepared statement 오류가 간헐적으로 나타난다면 pool mode와 driver 옵션을 함께 살펴봅니다.

이 문제를 해결하려고 prepared statement를 전부 끄기 전에 실제 workload를 봅니다. 짧은 쿼리가 매우 많다면 성능 영향이 있을 수 있고, driver나 PgBouncer 버전에 따라 지원 방식이 달라질 수 있습니다. representative query와 application version으로 staging test를 만들고, 정상·재연결·failover·pool reuse 상황에서 동작을 확인합니다. 설정 한 줄의 호환성 조언을 다른 언어와 driver에 그대로 복사하지 않는 것이 중요합니다.

cursor도 비슷한 경계가 있습니다. 여러 fetch에 걸쳐 server-side cursor를 사용하는 report는 session이 유지된다는 가정을 할 수 있습니다. transaction이 끝난 뒤 결과를 계속 읽으려면 session pooling 또는 다른 pagination 방식이 필요할 수 있습니다. 이러한 제약은 PgBouncer의 결함이 아니라 연결을 공유하는 방식의 특성입니다. 어떤 기능이 연결 지속성을 요구하는지 드러내는 계기로 삼는 편이 좋습니다.

## 배포와 장애 복구를 실제 흐름으로 연습하기

PgBouncer 설정을 바꿀 때는 새 설정 문법이 맞는지만 확인해서는 부족합니다. 새 instance를 추가하거나 pool mode를 바꾸면 기존 client connection, in-flight transaction, health check, load balancer의 drain 순서가 영향을 받습니다. 갑자기 모든 client를 끊으면 요청 실패와 reconnect 폭주가 겹칠 수 있습니다. 가능한 경우 새 instance를 준비해 일부 traffic을 옮기고, 오래 idle인 connection부터 정리하며, 현재 진행 중인 transaction이 끝날 시간을 고려합니다.

database failover 뒤에는 old connection이 언제 실패하고 새 primary에 언제 연결되는지 확인합니다. application이 읽기와 쓰기에 같은 endpoint를 쓰는지, DNS나 proxy의 갱신 시간이 어떤지, PgBouncer가 인증 실패를 반복할 때 어떤 로그와 metric을 내는지도 runbook에 넣습니다. 단순 ping 성공보다 실제 작은 read와 idempotent한 write 검증이 더 의미 있을 수 있습니다. 쓰기 결과가 모호해질 수 있으므로 검증용 작업도 안전한 test record로 제한합니다.

credential rotation은 특히 주의가 필요합니다. 새 password나 인증 방식이 적용돼도 이미 열린 server connection은 한동안 기존 credential으로 유지될 수 있습니다. 새 연결이 정상적으로 열리는지, 순차적으로 오래된 연결을 교체할 수 있는지, 잘못된 secret 배포 시 어디로 rollback할지를 검증합니다. secret 값을 log에 출력하지 않고 secret version과 인증 성공·실패 건수만 관찰합니다.

## 관찰 지표를 사용자 경험과 연결하기

PgBouncer의 client active, client waiting, server active, server idle, pooler error는 필수 지표지만 독립적으로 해석하면 안 됩니다. client waiting이 늘었을 때 API p95 latency와 timeout이 같이 늘어나는지, server active가 가득 찼을 때 database CPU와 disk I/O가 포화인지, lock wait가 높은지, 느린 query가 있는지 연결합니다. 사용자는 “pool waiting이 20개”가 아니라 주문이 늦고 오류가 난다는 경험을 하기 때문입니다.

경보도 단순 최대치보다 지속 시간과 영향도를 반영합니다. 짧은 burst로 waiting이 잠시 늘어도 사용자 오류가 없고 곧 회복된다면 즉시 심각 경보가 아닐 수 있습니다. 반면 waiting이 낮아도 특정 고우선 요청이 계속 timeout된다면 조사가 필요합니다. latency, 오류율, 대기열, database 자원, 긴 transaction을 조합해 단계적 경보와 runbook을 만듭니다.

대시보드에 배포·설정 변경 시각을 표시하면 원인 분석에 도움이 됩니다. 새 release 뒤 connection error가 늘었는지, batch 시작과 waiting 증가가 겹치는지, failover 연습 뒤 reconnect 시간이 바뀌었는지 빠르게 비교할 수 있습니다. 그러나 시간상 함께 일어났다는 사실만으로 원인을 단정하지는 않습니다. trace, query 상태, 설정 diff를 함께 검토해 가설을 확인합니다.

## 테스트 전략과 운영 변경의 경계

단위 테스트는 application이 connection acquire timeout을 올바른 오류로 바꾸는지, transaction 안에서 `SET LOCAL`을 쓰는지, connection 누수 없이 반환하는지 확인할 수 있습니다. 통합 테스트는 실제 PostgreSQL과 PgBouncer를 포함해 transaction pooling에서 세션 상태가 초기화되는지, driver가 재연결 후 정상 동작하는지 확인할 수 있습니다. 이 테스트는 production의 모든 트래픽을 복제하지 않지만, mode 변경으로 깨질 수 있는 계약을 빠르게 잡습니다.

staging에서는 실제와 유사한 connection 예산과 여러 application instance를 사용해 burst, 긴 query, PgBouncer restart, database 재연결을 제한된 범위에서 실험합니다. 운영에서 직접 부하를 주는 실험은 고객 영향과 rollback 기준을 갖춰야 하며, 아무런 보호 없이 connection을 고갈시키는 방식은 피합니다. 운영 변경은 pool size 숫자만 바꾸는 일이 아니라 서비스의 backpressure와 장애 대응 계약을 바꾸는 일입니다.

마지막으로 PgBouncer가 없던 시절의 문제를 잊지 않도록 기준선을 남깁니다. 도입 전후의 연결 생성률, database backend 수, client 대기, 사용자 latency, 오류율을 같은 조건에서 비교합니다. 예상한 효과가 없으면 설정을 더 복잡하게 쌓기보다 workload와 병목 가설을 다시 확인합니다. 관리 가능한 단순함은 적은 설정 줄 수가 아니라, 장애 때 팀이 왜 그렇게 동작하는지 설명할 수 있는 상태입니다.

## 한계와 적용 기준 Q&A

### Q. 애플리케이션 자체 pool이 있는데 PgBouncer까지 필요할까요?

A. 항상 필요하지는 않습니다. 단일 서비스 instance와 작은 연결 수라면 driver pool만으로 충분할 수 있습니다. 여러 instance·여러 언어·짧은 transaction이 많고 database 연결 예산을 중앙에서 통제해야 할 때 PgBouncer의 가치가 커집니다. 먼저 현재 connection 생성 비용, idle connection 수, database 자원, 장애 패턴을 측정해 문제를 확인합니다.

### Q. transaction pooling으로 바꾸면 ORM이 바로 깨지나요?

A. ORM 종류와 설정에 따라 다릅니다. 세션 변수, prepared statement, cursor, 임시 테이블, advisory lock을 어떻게 쓰는지에 달려 있습니다. staging에서 대표 read/write 흐름, background job, migration, 오류 처리 경로를 실제 pool mode로 검증하고, 호환성 설정이나 session pool 분리가 필요한지 판단해야 합니다.

### Q. pool을 크게 하면 timeout이 사라지나요?

A. 잠시 대기열이 줄 수는 있지만 database CPU·I/O·lock 경합이 이미 병목이면 더 많은 동시 쿼리가 문제를 악화시킬 수 있습니다. timeout은 pool 크기뿐 아니라 느린 query, transaction 길이, connection 누수, dependency 장애, 재시도 폭주를 함께 분석해야 합니다.

## 안전한 도입 순서

먼저 현재 application별 최대 pool, 실제 active/idle connection, database 예약 연결, 긴 transaction, 오류와 latency를 목록으로 만듭니다. 그 뒤 위험이 낮은 stateless read API 하나를 대상으로 PgBouncer를 붙이고 session pooling에서 연결·인증·관찰성을 확인합니다. transaction pooling은 세션 상태 의존성 목록과 compatibility test가 준비된 뒤 별도로 전환합니다.

도입 후에는 dashboard에 client active/waiting, server active/idle, pool timeout, connection error, query latency, database CPU·memory·lock wait를 함께 둡니다. 한 지표만 보면 pool이 문제인지 database가 문제인지 알기 어렵습니다. max connection과 pool size, timeout, 각 user의 역할은 configuration repository와 runbook에 기록하고, 변경 전후의 사용자 latency와 오류율로 결과를 판단합니다.

PgBouncer의 최종 목적은 숫자를 줄이는 것이 아니라 PostgreSQL을 예측 가능하게 사용하는 것입니다. 짧은 작업은 연결을 효율적으로 공유하고, 긴 작업은 중요한 API를 막지 않으며, 세션 상태와 권한은 암묵적으로 섞이지 않게 해야 합니다. 이 경계를 명확히 하면 pooler는 장애를 숨기는 중간 계층이 아니라 용량·보안·서비스 품질을 함께 관리하는 운영 도구가 됩니다.

## 읽기 복제본과 연결 대상을 분리할 때의 주의점

읽기 부하를 줄이기 위해 primary와 read replica를 함께 쓰는 시스템에서는 PgBouncer의 database 별칭과 application 연결 정책이 더 중요해집니다. 모든 읽기를 replica로 보내면 write 직후 사용자가 자신의 변경을 못 보는 read-after-write 문제가 생길 수 있습니다. 주문을 만든 직후 주문 상세를 조회하는 흐름, 관리자 화면의 최신 정산 상태, 캐시가 비어 있는 조회처럼 최신성이 필요한 요청은 primary를 읽어야 할 수 있습니다.

애플리케이션에서 SQL 문장을 보고 자동으로 읽기와 쓰기를 분리하는 방식은 생각보다 위험합니다. `SELECT`처럼 보이는 문장도 lock을 잡거나 함수를 통해 상태를 바꿀 수 있고, transaction 안에서는 여러 statement가 같은 일관성 경계를 가져야 합니다. endpoint 또는 업무 의도에 따라 명시적으로 read/write 연결 대상을 나누고, 어느 요청이 어떤 replica lag를 허용하는지 정하는 편이 검증하기 쉽습니다.

replica가 지연되거나 끊겼을 때의 fallback도 설계합니다. 최신성이 중요하지 않은 검색 페이지는 잠시 오래된 결과를 보여 줄 수 있지만, 재고·권한·주문 상태는 오래된 값을 보여 주면 더 큰 문제가 될 수 있습니다. 무조건 primary로 몰아 보내는 fallback은 장애를 확산시킬 수 있으므로, 업무별로 오류를 반환할지, 기능을 제한할지, 캐시된 결과를 보여 줄지 기준을 정합니다. PgBouncer는 이 라우팅 정책을 대신 판단하지 않습니다.

## multi-tenant와 user별 격리의 경계

여러 고객 조직이 같은 PostgreSQL cluster를 공유할 때 연결 pool은 용량 격리에도 영향을 줍니다. 한 tenant의 대량 export가 모든 server connection을 점유하면 다른 tenant의 짧은 API 요청이 기다릴 수 있습니다. tenant마다 별도 database나 user를 쓰는 방식, workload 종류별 pool을 나누는 방식, application 수준의 concurrency limit을 조합할 수 있습니다. 어느 수준의 격리가 필요한지는 고객 수와 규제, 데이터 분리, 운영 비용을 함께 봐야 합니다.

PgBouncer의 user별 pool 제한은 한 종류의 보호 장치가 될 수 있지만, tenant 공정성을 완전하게 보장하지는 않습니다. 같은 runtime user를 공유한다면 pooler는 요청이 어느 고객의 것인지 알지 못합니다. application queue와 rate limit, 쿼리 비용 제한, background job scheduling이 함께 필요할 수 있습니다. 연결 수가 적다는 사실과 자원이 공정하게 쓰인다는 사실은 다릅니다.

row-level security를 사용하는 경우에도 연결 재사용과 사용자 문맥 전달을 조심해야 합니다. 요청별 tenant ID를 설정한다면 transaction 범위에서만 유효하게 하고, 오류나 조기 반환 뒤에 이전 값이 남지 않는지 통합 테스트로 확인합니다. connection pool이 편리하다는 이유로 tenant 식별을 신뢰할 수 없는 client 값에서 가져오거나, 검증 없이 세션 변수에 넣어서는 안 됩니다. 인증된 identity와 database 정책의 연결이 먼저입니다.

## 관리 작업을 위한 별도 통로 확보하기

장애가 발생했을 때는 application traffic을 줄이는 일뿐 아니라 사람이 database와 PgBouncer 상태를 조사할 수 있어야 합니다. 모든 connection 예산을 runtime 서비스에 주면 관리자가 lock 상태를 보거나 긴 query를 취소할 연결도 얻지 못할 수 있습니다. 제한된 관리자 계정과 예약된 연결 예산, 읽기 전용 관찰 query, 비상시 사용할 접속 경로를 사전에 마련합니다. 이 계정은 평상시 애플리케이션에서 쓰지 않고 감사 기록과 강한 인증을 적용합니다.

관리 작업도 pool을 우회한다고 해서 안전한 것은 아닙니다. 긴 query를 무심코 실행하면 이미 바쁜 database를 더 느리게 만들 수 있고, 세션을 강제 종료하면 진행 중인 업무 transaction이 rollback될 수 있습니다. runbook에는 확인할 지표의 순서, 안전한 조회 query, escalation 조건, 어떤 작업은 승인 뒤에만 할 수 있는지를 적습니다. 운영자는 긴급 상황에서도 시스템을 더 악화시키지 않는 절차가 필요합니다.

schema migration은 일반 API와 다른 연결 특성을 가질 수 있습니다. migration 도구가 session 설정, lock, 긴 transaction을 사용한다면 transaction pooling API 계정과 같은 경로를 쓰지 않는 편이 안전할 수 있습니다. 배포 전 migration을 별도 계정과 제한된 시간 창에서 수행하고, lock timeout과 rollback 가능성, application version 호환성을 검토합니다. PgBouncer 설정 변경과 schema 변경을 같은 배포에 한꺼번에 넣으면 원인 분리가 어려우므로 가능한 한 나눕니다.

## 비용과 성능을 해석하는 기준

PgBouncer 도입 뒤 database backend 수가 줄었다고 해서 비용과 성능이 자동으로 좋아졌다고 단정하지 않습니다. backend 수가 줄어 memory 압박이 낮아질 수 있지만, client waiting이 늘어 사용자 latency가 악화될 수도 있습니다. 연결 생성 횟수, connection 사용률, pool 대기 시간, query 실행 시간, 오류율, database CPU와 I/O를 함께 비교해야 합니다. 기준선 없이 변경 뒤 그래프만 보면 단기 traffic 변화와 설정 효과를 혼동할 수 있습니다.

load test는 실제 쿼리 분포와 데이터 크기에 가깝게 설계합니다. 단순한 `SELECT 1`을 초당 수천 번 실행해도 복잡한 조인, 쓰기, lock 경합, cache miss가 있는 서비스의 pool 동작을 대표하지 못합니다. 빠른 읽기, 느린 보고서, 짧은 쓰기, 실패와 재시도가 섞인 workload를 만들고, 각 요청의 성공률과 높은 지연 구간을 관찰합니다. 테스트에서 얻은 숫자는 해당 조건의 결과라는 범위를 문서에 함께 남깁니다.

성능 개선의 우선순위는 pool size보다 쿼리와 업무 흐름일 때가 많습니다. 불필요하게 큰 결과를 읽는 조회, 인덱스 없는 조건, transaction 안의 외부 호출, 반복된 재시도, 작은 쿼리를 수백 번 보내는 방식은 pooler를 추가해도 남습니다. 연결 관리는 이러한 문제를 드러내는 관찰 지점으로 활용하고, 명확한 병목을 고친 뒤 필요한 크기만큼 pool을 조정합니다.

## 운영 문서에 남겨야 할 질문

팀의 runbook에는 단순한 설정 파일 복사본보다 판단 기준을 남깁니다. 현재 PgBouncer instance 수와 endpoint는 무엇인가, 각 database와 user에 어떤 pool 한도가 있는가, 총 server connection 예산은 어떻게 계산했는가, session pooling이 필요한 기능은 무엇인가, transaction pooling에서 금지하거나 검증한 기능은 무엇인가를 기록합니다. 새 서비스가 추가될 때 어떤 절차로 pool 예산을 요청하는지도 있어야 합니다.

장애 절차에는 client waiting이 늘었을 때 무엇을 먼저 보는지 적습니다. PgBouncer가 다운됐는지, database가 새 연결을 거부하는지, 긴 transaction이 늘었는지, lock wait나 느린 query가 있는지, 특정 batch가 예산을 다 쓰는지 차례로 확인합니다. 처음부터 pool size를 늘리는 행동은 마지막 선택지여야 합니다. 문제의 위치를 확인한 뒤에만 한도·timeout·workload를 조정해야 부하를 다른 계층으로 옮기지 않습니다.

정기 점검에서는 사용하지 않는 database alias와 계정, 너무 큰 client limit, 오래된 인증 방식, 더 이상 존재하지 않는 application endpoint를 제거합니다. 설정을 계속 추가하기만 하면 장애 때 어떤 값이 실제로 적용되는지 알기 어렵습니다. 작은 구성과 명확한 문서, 반복 가능한 검증은 PgBouncer를 오래 운영할수록 더 큰 가치를 만듭니다.

<h3 class="references-heading">참고 자료</h3>

- [PgBouncer Features](https://www.pgbouncer.org/features.html)
- [PostgreSQL Documentation: Connections and Authentication](https://www.postgresql.org/docs/current/runtime-config-connection.html)
