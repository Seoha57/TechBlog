---
layout: post
title: "PostgreSQL 인덱스 비대를 다루는 법: 크기 측정·원인 분석·REINDEX CONCURRENTLY 적용 기준"
categories: [DBA]
tags: [dba, postgresql, index, bloat, reindex, maintenance, performance]
description: "PostgreSQL B-tree 인덱스 비대가 생기는 이유를 이해하고, 테이블·인덱스 크기와 사용량을 점검한 뒤 REINDEX CONCURRENTLY를 안전하게 계획·검증하는 방법을 설명합니다."
---

## 먼저 답하기

### Q. PostgreSQL 인덱스 크기가 크면 모두 비대(bloat)인가요?

A. 아니다. 인덱스가 큰 이유는 행 수와 key 길이, 여러 인덱스, 낮은 선택도, fillfactor, 정상적인 데이터 증가처럼 다양하다. 비대는 더 이상 유효한 index entry가 많지 않은데도 페이지가 비효율적으로 남아 공간과 I/O를 쓰는 상태를 말한다. 크기 하나만 보고 "비대이니 REINDEX"라고 결론 내리면, 정상적으로 큰 인덱스를 불필요하게 재구성하거나 더 중요한 문제를 놓칠 수 있다. 증가 추세, 쓰기 패턴, query plan, 디스크 여유, 유지보수 창을 함께 본다.

### Q. `REINDEX CONCURRENTLY`는 운영 중에도 아무 위험 없이 실행할 수 있나요?

A. 아니다. 동시 REINDEX는 일반 REINDEX보다 쓰기 차단을 줄이지만, 추가 디스크 공간과 시간, transaction block 제약, 오래 실행 중인 transaction·lock과의 상호작용, 실패 뒤 invalid index 점검 같은 고려 사항이 있다. PostgreSQL 공식 문서도 일반 REINDEX는 기본적으로 강한 lock을 요구하고, concurrent 옵션은 쓰기를 막지 않는 대신 별도 주의점이 있음을 설명한다. production에서는 대상·버전·공간·백업·모니터링·rollback 판단을 갖춘 뒤 좁은 인덱스부터 실행한다.

## 먼저 알아둘 기반 기술

### PostgreSQL 인덱스와 B-tree

인덱스(index)는 테이블의 모든 행을 순서대로 읽지 않고 조건에 맞는 행을 빨리 찾기 위한 보조 자료구조다. PostgreSQL에서 B-tree는 equality와 범위 조건에 널리 쓰이는 기본 인덱스 방식이다. 예를 들어 주문 테이블의 `created_at` 인덱스는 최근 기간 주문을 조회할 때 도움이 될 수 있다. 하지만 인덱스는 읽기 비용을 줄이는 대신 insert·update·delete마다 유지 비용과 저장 공간을 쓴다.

인덱스가 있다고 항상 query가 빨라지는 것은 아니다. planner는 통계와 비용 모델을 보고 index scan, bitmap scan, sequential scan 중 하나를 고른다. 테이블 대부분을 읽어야 하는 쿼리에서는 sequential scan이 더 저렴할 수 있다. 따라서 인덱스 비대 정비는 "인덱스를 더 많이 만들기"가 아니라, 실제로 쓰이는 인덱스가 정상적인 공간·쓰기 비용·응답 시간을 갖도록 유지하는 일이다.

### MVCC와 dead tuple

PostgreSQL은 MVCC(Multi-Version Concurrency Control, 읽기와 쓰기가 서로 덜 막히도록 행의 여러 버전을 관리하는 방식)를 사용한다. UPDATE는 종종 기존 행을 즉시 덮어쓰는 대신 새 version을 만들고, DELETE는 행을 바로 물리적으로 없애기보다 더 이상 보이지 않게 표시한다. 더 이상 어떤 transaction에도 필요하지 않은 오래된 version은 vacuum이 재사용할 수 있도록 정리한다.

테이블의 dead tuple과 인덱스의 공간 문제는 관련 있지만 같은 말은 아니다. autovacuum은 많은 경우 dead tuple을 청소하고 공간을 재사용 가능하게 하지만, 파일 크기를 운영체제에 즉시 돌려주는 일반적인 shrink 도구는 아니다. B-tree에서도 삭제된 key가 있던 페이지가 나중에 재사용될 수 있지만, 특정 key 범위에서 반복 삭제가 일어나 각 페이지에 소수 key만 남으면 페이지 자체가 계속 할당되어 비효율적인 공간 사용이 남을 수 있다.

### REINDEX가 하는 일

`REINDEX`는 기존 인덱스를 기반 테이블 데이터에서 새로 만들고 기존 사본을 교체하는 SQL 명령이다. 공식 문서는 손상된 인덱스 복구, 많은 빈·거의 빈 페이지를 가진 비대한 인덱스의 공간 감소, storage parameter 변경 반영 같은 경우를 사용 사례로 든다. 새 인덱스는 논리적으로 가까운 페이지가 물리적으로 더 가깝게 구성될 가능성이 있어, 많이 갱신된 B-tree를 다시 만들 때 접근 패턴이 나아질 여지도 있다. 하지만 이 글은 특정 환경에서 성능이 몇 퍼센트 개선된다고 주장하지 않는다. 측정 없이 결과를 약속할 수 없기 때문이다.

### lock과 transaction block

일반 `REINDEX INDEX`는 대상 테이블의 쓰기를 막을 수 있는 lock을 요구한다. `CONCURRENTLY` 옵션은 concurrent insert·update·delete를 막는 lock을 피하도록 설계됐지만, 아무 lock도 쓰지 않는다는 뜻은 아니다. 또한 모든 REINDEX 형태와 PostgreSQL 버전에서 같은 제약이 적용되는 것은 아니다. 공식 SQL reference와 사용하는 major version 문서를 반드시 확인해야 하며, concurrent reindex 명령은 transaction block 안에서 실행할 수 없는 경우가 있다. migration tool이 모든 SQL을 하나의 transaction으로 감싸는 설정이라면 특히 사전 검증이 필요하다.

## 인덱스 비대가 생기는 업무 패턴

### 시간순으로 들어오고 임의로 삭제되는 데이터

event log, 세션, 임시 토큰처럼 key는 증가하지만 retention job이 과거 범위 또는 특정 tenant 데이터를 삭제하는 테이블을 생각해 보자. 테이블에는 최근 데이터가 계속 들어오고, 인덱스의 여러 페이지에서는 일부 entry만 제거된다. 삭제된 entry 공간이 바로 인접한 새 key에 항상 재사용되는 것은 아니므로, 오랜 기간에는 인덱스 파일이 업무 데이터량보다 더 크게 유지될 수 있다.

### 자주 바뀌는 인덱스 key

상태, 정렬 점수, 만료 시각, 검색용 정규화 컬럼처럼 인덱스가 걸린 값을 자주 UPDATE하면 기존 index entry를 제거하고 새 entry를 추가해야 한다. 특히 값이 넓은 key 범위로 이동하면 B-tree의 다른 위치에 새 entry가 생긴다. 그렇다고 모든 update-heavy 테이블에 REINDEX를 주기적으로 걸어야 하는 것은 아니다. 실제 index size 증가, write latency, query plan, autovacuum 상태를 보고 판단한다.

### UUID와 랜덤 키를 단순한 원인으로 단정하지 않기

무작위 UUID는 증가하는 숫자 key보다 삽입 위치가 넓게 퍼질 수 있지만, 그것만으로 비대의 원인을 단정하면 안 된다. PostgreSQL version, B-tree 구현, fillfactor, 동시 insert, 삭제·update 비율, workload가 모두 영향을 준다. key 방식은 애플리케이션의 분산 생성·보안·샤딩 요구와 함께 선택해야 한다. index size가 커졌다는 관찰 뒤에는 해당 index가 어떤 predicate·정렬에 쓰이는지와 데이터 수명 주기를 먼저 읽는다.

## 첫 단계는 측정: 무엇이 큰지, 무엇이 쓰이는지 분리하기

### 테이블과 인덱스 크기 보기

다음은 사용자 테이블의 전체 크기와 index 크기를 큰 순서로 보는 출발점이다. 시스템 catalog 구조와 권한은 버전·환경에 따라 다를 수 있으므로 production에 적용하기 전 read-only 환경에서 결과를 확인한다.

```sql
SELECT
  schemaname,
  relname AS table_name,
  pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
  pg_size_pretty(pg_relation_size(relid)) AS table_size,
  pg_size_pretty(pg_indexes_size(relid)) AS indexes_size
FROM pg_catalog.pg_statio_user_tables
ORDER BY pg_total_relation_size(relid) DESC
LIMIT 30;
```

이 결과에서 indexes_size가 크다고 해서 삭제 대상은 아니다. 주문 검색, 최근 기록 정렬, foreign key 검증처럼 핵심 path에 필요한 index일 수 있다. 먼저 데이터 증가율과 비교하고, 같은 테이블의 query workload와 index scan 통계를 연결한다. report를 한 번 뽑는 것보다 주기적으로 snapshot을 저장해 증가율과 release·retention job 시점을 비교하는 편이 원인 분석에 도움이 된다.

### index 정의와 사용량 확인

```sql
SELECT
  schemaname,
  relname AS table_name,
  indexrelname AS index_name,
  idx_scan,
  pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
  pg_get_indexdef(indexrelid) AS index_definition
FROM pg_stat_user_indexes
JOIN pg_index USING (indexrelid)
ORDER BY pg_relation_size(indexrelid) DESC;
```

`idx_scan`이 낮다는 한 가지 이유로 index를 삭제하면 안 된다. 통계 reset 시점, 월말 배치처럼 드문 업무, unique constraint·primary key·foreign key 지원, 장애 시 복구 작업에서의 사용을 확인해야 한다. 반대로 크고 거의 쓰이지 않으며 제약도 아닌 index는 write overhead를 만들 수 있으므로, application owner와 query log를 근거로 별도 제거 검토 대상이 된다. 비대 정비와 unused index 제거는 서로 다른 변경이며 한 maintenance window에서 함께 무리하게 하지 않는 편이 안전하다.

### query plan과 실제 query를 연결한다

느린 쿼리가 특정 index 때문이라고 말하려면 `EXPLAIN (ANALYZE, BUFFERS)`처럼 실제 실행 계획을 읽어야 한다. 단, ANALYZE는 쿼리를 실제 실행하므로 production에서 무거운 쿼리에 무심코 실행하면 부하를 만들 수 있다. 안전한 환경·대표 parameter에서 먼저 보고, 운영에서는 query monitoring과 slow log를 통해 대상 쿼리를 좁힌다.

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT order_id, created_at, status
FROM orders
WHERE customer_id = 421
  AND created_at >= now() - interval '30 days'
ORDER BY created_at DESC
LIMIT 50;
```

계획에서 index scan이 보인다고 그 index가 비대라는 뜻은 아니고, sequential scan이 보인다고 index가 쓸모없다는 뜻도 아니다. rows estimate와 actual rows 차이, buffer read, sort, filter, join 조건을 함께 본다. 통계가 오래되었거나 predicate와 맞지 않는 index라면 REINDEX보다 ANALYZE, statistics target 조정, query·index 설계 검토가 먼저일 수 있다.

## 비대 추정 도구의 한계

PostgreSQL core에는 모든 index의 정확한 bloat 비율을 단일 숫자로 확정해 주는 일반 SQL이 없다. 확장 모듈, catalog 기반 추정 query, 파일 크기 변화, `pgstattuple` 계열 도구는 판단에 도움이 될 수 있지만 각각 권한·부하·통계 가정·지원 버전의 제약이 있다. 추정치가 30%라고 나왔다고 해서 실제로 30% 디스크를 즉시 회수하거나 성능이 30% 좋아지는 것은 아니다.

따라서 다음 증거를 조합한다.

| 증거 | 알려 주는 것 | 단독으로 부족한 이유 |
| --- | --- | --- |
| index 파일 크기 추세 | 공간이 늘어나는 속도 | 정상 데이터 증가와 구분 안 됨 |
| 사용량 통계 | index가 query에 쓰이는 정도 | 통계 reset·희귀 query를 놓칠 수 있음 |
| dead tuple·vacuum 지표 | MVCC 정리 압력 | index 내부 공간 효율을 직접 보장하지 않음 |
| query plan·latency | 실제 업무 영향 | parameter·cache 상태에 따라 달라짐 |
| bloat 추정 extension | 물리 구조의 단서 | 추정·권한·실행 비용이 존재 |

정비 후보는 이 증거들에서 "크고, 계속 커지고, 해당 데이터 수명 패턴이 있고, 업무상 유지보수 비용을 감당할 가치가 있다"는 합의가 있을 때 선택한다. 디스크가 충분하고 query가 안정적이며 증가 추세도 정상이라면 관찰만 하는 것이 더 좋은 결정일 수 있다.

## REINDEX와 REINDEX CONCURRENTLY의 선택

### 일반 REINDEX

일반 REINDEX는 더 단순하고 보통 더 짧은 작업이 될 수 있지만, 대상 테이블에 대한 쓰기와 해당 index를 쓰는 읽기에 영향을 줄 수 있다. maintenance window가 있고 대상이 작으며 애플리케이션을 잠시 정지할 수 있다면 예측 가능한 선택일 수 있다. 그러나 "읽기는 계속 되니 안전하다"고 가정하면 안 된다. planner가 index에 lock을 얻는 방식과 application query 경로를 고려해야 한다.

```sql
REINDEX INDEX public.orders_customer_created_at_idx;
```

이 명령은 production console에서 즉시 실행할 예시가 아니다. 대상이 맞는지, session에 열려 있는 transaction이 없는지, monitoring과 lock 관찰이 준비됐는지 확인한 뒤 change procedure 안에서 실행한다.

### 동시 REINDEX

`REINDEX INDEX CONCURRENTLY`는 일반적인 쓰기 작업을 막지 않고 index를 재구성하려는 선택지다. 온라인 workload에서 유용할 수 있지만, 새 index를 만들 동안 기존 index와 새 index가 함께 존재할 수 있어 여유 디스크가 필요하다. 작업 중 DDL·긴 transaction·lock 대기·복제 지연 같은 운영 신호를 관찰해야 한다.

```sql
REINDEX INDEX CONCURRENTLY public.orders_customer_created_at_idx;
```

동시 옵션은 모든 경우에 아무 영향도 없다는 약속이 아니다. PostgreSQL documentation은 concurrent rebuild가 쓰기를 막지 않는다고 설명하면서도, concurrent 작업이 실패하면 invalid index가 남을 수 있고 특정 명령 형태에는 제약이 있음을 안내한다. 실행 전에는 현재 PostgreSQL major version의 `REINDEX` 문서를 보고 지원 범위와 transaction block 제한을 확인한다. migration framework, connection pool, job runner가 명령을 묶어 실행하지 않는지도 확인한다.

### 대상 범위를 작게 잡는 이유

`REINDEX DATABASE CONCURRENTLY`처럼 넓은 범위를 한 번에 다루는 명령은 편해 보이지만, 대상 index 수·디스크·실행 시간·문제 범위가 커진다. 처음에는 명확한 근거가 있는 index 하나를 고르고, 결과와 부작용을 확인한 뒤 다음 대상으로 진행한다. 테이블의 모든 index가 필요하다면 `REINDEX TABLE`의 영향과 partition·TOAST 관련 동작도 문서에서 확인한다. maintenance 작업의 가장 안전한 단위는 되돌릴 수 있거나 영향 범위를 설명할 수 있는 단위다.

## 실행 전·중·후 runbook

### 실행 전: 대상과 실패 기준을 합의한다

1. 대상 database, schema, table, index OID와 정의를 read-only query로 기록한다.
2. index size, table size, 디스크 여유, 최근 증가 추세, primary·unique·foreign key 연관성을 확인한다.
3. 현재 실행 중인 긴 transaction, 해당 table의 lock 대기, 배치·대량 import·schema migration 일정을 확인한다.
4. logical·physical backup과 복구 절차, 담당 DBA와 application owner의 연락 경로를 확인한다.
5. 작업을 중단하거나 다음 maintenance window로 넘길 기준을 정한다. 예를 들어 디스크 여유가 임계치 아래로 내려가거나 replication lag가 서비스 목표를 넘는 경우다.

여기서 backup은 REINDEX rollback 버튼과 동일하지 않다. concurrent reindex가 정상 완료되면 이전 index 사본은 교체된다. 따라서 작업 자체를 취소할 수 있는 시점, 실패 후 invalid index를 어떻게 확인할지, 더 넓은 복구가 필요한 예외 상황은 무엇인지 미리 문서화한다. 백업이 있다는 이유로 lock·공간·대상 검증을 생략할 수는 없다.

### 실행 중: 진행률과 부작용을 본다

PostgreSQL이 제공하는 progress view와 monitoring 도구의 지원 범위는 version에 따라 다를 수 있다. 가능한 경우 재구성 작업의 진행 상태, sessions, lock waits, disk utilization, replication lag, API error rate를 함께 본다. SQL client의 명령이 멈춘 것처럼 보여도 즉시 다른 session에서 같은 명령을 다시 실행하지 않는다. 먼저 해당 backend가 어떤 lock을 기다리는지, long transaction이 무엇인지, 이미 concurrent build가 진행 중인지 확인한다.

```sql
SELECT
  pid,
  usename,
  application_name,
  state,
  wait_event_type,
  wait_event,
  query_start,
  query
FROM pg_stat_activity
WHERE datname = current_database()
ORDER BY query_start NULLS LAST;
```

이 query 결과에는 민감한 SQL parameter나 사용자 정보가 포함될 수 있다. 운영 채널에 전체 결과를 붙이기보다 접근 제어된 곳에서 확인하고, 공유할 때는 필요한 필드만 마스킹한다. 또한 long-running session을 무조건 terminate하면 업무 transaction을 잃을 수 있다. owner와 영향도를 확인한 뒤 조직의 incident 절차에 따른다.

### 실행 후: 크기 감소만 보지 않는다

완료 후에는 새 index가 valid인지, 예상 정의와 tablespace를 갖는지, application query가 정상 plan을 선택하는지, 오류·lock wait·replication lag가 정상 범위로 돌아왔는지 확인한다. 이전 snapshot과 size를 비교할 수 있지만, 줄어든 bytes만으로 성공을 선언하지 않는다. 실행 도중 write latency가 악화됐는지, autovacuum과 다른 maintenance가 충돌했는지, 배포·batch job에 영향이 있었는지도 회고한다.

작업 기록에는 대상, 시작·종료 시각, PostgreSQL version, 명령, 결과, size 변화, 관찰한 경고, 다음 검토일을 남긴다. 이 기록이 쌓이면 "매월 모든 index를 재구성" 같은 추측 대신 실제 workload별 maintenance 주기를 판단할 수 있다.

## 구체적인 업무 예시: 만료 세션 테이블의 인덱스 정비

가상의 인증 서비스가 `user_sessions` 테이블에 활성 세션을 저장한다고 하자. `expires_at` 인덱스는 만료 세션을 찾는 cleanup job과 사용자 세션 검증에 쓰인다. 세션은 매일 대량 생성되고 만료 후 삭제되며, retention 정책이 바뀌어 과거 세션을 대량 삭제한 뒤 index size가 계속 크게 남는다.

팀은 먼저 다음을 확인한다. `expires_at` 인덱스가 실제 cleanup과 lookup에서 쓰이는지, 같은 기능의 partial index가 있는지, table에서 삭제가 어느 시간대에 일어나는지, autovacuum이 지연되는지는 어떤지, 해당 database volume에 새 index를 만들 여유 공간이 있는지다. 이 결과를 바탕으로 business peak가 아닌 시간에 test replica 또는 staging에서 `REINDEX INDEX CONCURRENTLY` 절차를 검증한다.

production change에서는 index 하나만 대상으로 실행하고, connection pool 오류, cleanup job 지연, replication lag, disk growth, session lookup error rate를 관찰한다. 성공한 뒤에도 즉시 전체 database 재구성으로 넓히지 않는다. 새 size와 쿼리 상태, 다음 주의 증가율을 보고 동일한 delete pattern이 계속되는지 확인한다. 만약 계속 빠르게 다시 커진다면 REINDEX는 증상 완화일 뿐, retention batch의 삭제 방식, partitioning, index design, autovacuum 설정을 다시 검토해야 한다.

## REINDEX로 해결되지 않는 문제

### 잘못된 인덱스 설계

쿼리의 filter와 sort를 지원하지 않는 index, 중복된 단일 컬럼 index, 낮은 선택도의 컬럼에 무심코 만든 index는 REINDEX해도 설계 문제가 남는다. `EXPLAIN`과 실제 workload를 보고 composite index 순서, partial index 조건, covering index의 필요성을 검토한다. 단, index를 추가·삭제하는 작업은 query regression과 write cost를 바꾸므로 별도의 change로 평가한다.

### autovacuum 지연과 table bloat

autovacuum이 충분히 돌지 않아 dead tuple이 계속 쌓인다면 index만 다시 만들어도 table 파일과 MVCC 정리 문제는 남는다. vacuum threshold, analyze frequency, long transaction, replication slot, transaction ID wraparound 위험을 함께 조사해야 한다. `VACUUM FULL`은 테이블을 다시 쓰고 강한 lock을 요구할 수 있어, REINDEX CONCURRENTLY와 같은 온라인 maintenance로 생각하면 안 된다. 목적과 잠금 특성이 다르므로 각각의 공식 문서와 change window를 따로 검토한다.

### 디스크·I/O 병목

인덱스가 크다고 해서 query 지연의 원인이 꼭 index 내부 fragmentation인 것은 아니다. storage latency, cache hit ratio, checkpoint, WAL write, network, connection pool saturation이 더 큰 원인일 수 있다. REINDEX는 많은 읽기·쓰기 I/O를 만들 수 있으므로 이미 storage가 포화된 상태에서 실행하면 상태를 악화시킬 수 있다. 먼저 관찰한 병목을 해결할 수 있는지 판단한다.

## 인덱스 유지보수를 서비스 변경으로 다루는 방법

REINDEX는 DBA가 콘솔에서 실행하는 단발성 명령처럼 보이지만, 실제로는 데이터 구조를 바꾸는 production change다. index 이름 하나를 잘못 선택하거나 예상보다 넓은 범위를 지정하면 영향은 database 전체로 커질 수 있다. 그래서 change request에는 SQL 한 줄뿐 아니라 대상 근거, 예상 시간, 필요한 디스크, 관찰 항목, 중단·에스컬레이션 기준을 포함한다.

### 대상 식별자를 이름만으로 신뢰하지 않는다

운영 database에는 비슷한 이름의 index가 여러 schema에 있을 수 있고, migration 과정에서 이름이 바뀌거나 partition마다 자동 이름이 생길 수 있다. 명령 전에는 schema-qualified name, table, index definition, OID를 확인하고 change record에 남긴다. `search_path`에 따라 다른 객체를 잡지 않도록 SQL에서 schema를 명시하는 습관도 필요하다.

```sql
SELECT
  c.oid AS index_oid,
  n.nspname AS schema_name,
  c.relname AS index_name,
  t.relname AS table_name,
  pg_get_indexdef(c.oid) AS definition
FROM pg_class AS c
JOIN pg_namespace AS n ON n.oid = c.relnamespace
JOIN pg_index AS i ON i.indexrelid = c.oid
JOIN pg_class AS t ON t.oid = i.indrelid
WHERE c.oid = 'public.orders_customer_created_at_idx'::regclass;
```

이 query는 대상 확인의 출발점이다. 출력에 expression index, partial predicate, collation, tablespace가 있으면 새 index가 동일한 의미로 만들어지는지 추가 확인한다. primary key나 unique constraint를 뒷받침하는 index일 때는 application과 foreign key 검증에 미칠 영향을 더 보수적으로 평가한다. 이름이 `idx_`로 시작한다는 이유만으로 일반 보조 index라고 가정해서는 안 된다.

### 용량 계획은 peak가 아니라 작업 중복을 기준으로 한다

concurrent reindex는 새 인덱스를 만든 뒤 기존 것을 교체하는 과정이므로, 단순히 최종 index 크기만큼만 공간이 필요하다고 보면 위험하다. 대상 index 크기, WAL 발생, 다른 배치의 파일 증가, replication slot이 유지하는 WAL, tablespace의 여유, storage auto-expand 속도를 함께 고려한다. exact한 여유 비율은 인프라와 workload에 따라 달라 이 글에서 단일 숫자를 제시하지 않는다. 대신 "현재 여유 공간"뿐 아니라 작업 중 최대 사용량을 모니터링하고 임계값에서 중단할 책임자를 정한다.

disk full은 REINDEX 자체 실패에 그치지 않을 수 있다. database write, checkpoint, WAL archive, replication에 연쇄 영향이 갈 수 있다. 그래서 volume 알림을 작업 시작 전부터 보고, 같은 시간에 대형 import, backup, vacuum full, bulk delete가 예정돼 있지 않은지 calendar를 확인한다. 하나의 maintenance 작업만 따로 안전하더라도 다른 작업과 겹치면 안전하지 않을 수 있다.

### read replica에서 무엇을 확인할 수 있는가

read replica는 index 크기 추세와 query plan을 관찰하는 데 유용할 수 있지만, primary에서 실행할 concurrent reindex의 lock·WAL·복제 영향을 완전히 대체해 검증하지는 못한다. replica가 primary보다 다른 workload, 다른 cache 상태, 다른 version, 다른 storage를 쓴다면 결과가 다를 수 있다. replica에서 대상 정의와 read-only 진단 query를 검증하고, production에는 좁은 대상·관찰·중단 기준을 갖고 진행하는 방식이 현실적이다.

## autovacuum과 index maintenance를 함께 읽기

인덱스 비대 논의를 하면 종종 autovacuum parameter를 높이거나 낮추는 처방이 바로 나온다. autovacuum은 PostgreSQL의 핵심 유지보수 기능이며, dead tuple 정리·통계 갱신·transaction ID 안전성에 관여한다. 하지만 하나의 global setting을 바꾸면 모든 table에 영향이 갈 수 있으므로, 특정 테이블의 변화율과 vacuum history를 먼저 본다. workload가 다른 테이블에 동일한 threshold와 cost 설정을 강제하면 오히려 중요한 테이블의 maintenance가 늦어질 수 있다.

### long-running transaction이 만드는 문제

오래 열린 transaction은 오래된 row version을 계속 필요하게 만들어 vacuum이 제거할 수 있는 범위를 제한할 수 있다. idle in transaction session, 잊힌 reporting query, 장시간 migration, replication 관련 설정은 dead tuple과 storage 증가의 원인이 될 수 있다. REINDEX로 index 파일을 정리해도 long transaction의 근본 원인이 남으면 table·index 유지 비용은 다시 쌓일 수 있다.

`pg_stat_activity`에서 오래된 session을 찾았다고 바로 kill하는 것은 안전한 대응이 아니다. 해당 session이 어떤 업무·owner·transaction 상태인지 확인하고, application timeout·connection pool·report query window를 고치는 방향을 먼저 검토한다. 운영 지표에서 반복되는 long transaction은 DBA만의 문제가 아니라 application lifecycle과 배치 설계의 문제일 수 있다.

### retention과 partitioning의 관계

시간이 지난 데이터를 대량 삭제하는 테이블에서 retention이 항상 `DELETE ... WHERE created_at < ...`라면, 테이블과 index에 지속적인 churn이 생길 수 있다. 데이터 접근과 보관 정책에 따라 range partitioning을 사용하면 오래된 기간 partition을 detach·drop하는 방식이 더 적절할 수 있다. 그러나 partitioning은 maintenance 명령 하나를 바꾸는 수준이 아니라 query, unique key, foreign key, migration, backup, application routing에 영향을 주는 설계 결정이다. REINDEX의 반복 필요성이 보인다는 사실은 partitioning 검토의 입력이 될 수 있지만, 자동 결론은 아니다.

## 실패·중단 뒤의 정합성 확인

### concurrent 작업이 실패했을 때

network 연결이 끊기거나 disk가 부족하거나 lock·transaction 문제가 생기면 concurrent index build가 정상 완료되지 않을 수 있다. 이때 가장 위험한 행동은 실패 메시지를 읽지 않고 같은 명령을 반복 실행하는 것이다. 먼저 PostgreSQL log와 command error, 대상 index의 validity, catalog 상태, 현재 진행 중인 관련 backend를 확인한다. invalid index가 남았는지, 기존 usable index는 무엇인지, application plan이 예상대로 동작하는지를 조사한 뒤 다음 조치를 선택한다.

PostgreSQL 공식 `REINDEX` 문서는 concurrent index build가 실패한 뒤 invalid index가 남을 수 있으며, invalid index에 대해 concurrent rebuild를 할 수 있는 경우를 설명한다. 그러나 실제 복구 명령은 version·대상·오류 원인에 따라 달라질 수 있다. 따라서 runbook에는 "실패하면 이 SQL을 무조건 실행"보다, error evidence를 저장하고 DBA owner가 대상 상태를 확인한 뒤 재시도·일반 maintenance window·복구 절차 중 하나를 선택하도록 적는 편이 안전하다.

### 작업 취소와 애플리케이션 영향

진행 중인 command를 취소해야 할 때도 backend 종료와 query cancel의 차이, 해당 session이 단일 maintenance command인지, disk·lock·replication 상황을 확인한다. 작업을 멈췄다고 해서 생성되던 구조가 자동으로 완전히 사라졌다고 가정하지 않는다. 취소 후에는 catalog, index validity, disk usage, application error, replica 상태를 다시 점검한다. 재시도는 기존 job이 완전히 정리됐고 입력 조건이 같은지 확인한 뒤 별도의 attempt로 남긴다.

### application team과의 확인 항목

DBA 관점에서 index가 valid여도 application owner에게는 query timeout, connection pool error, slow endpoint, batch backlog로 보일 수 있다. maintenance window 중에는 endpoint error rate, p95 latency, queue backlog, job failure, DB connection 수를 함께 볼 담당자를 정한다. 완료 뒤에는 대표 기능의 read·write smoke test를 수행한다. database maintenance를 성공이라고 선언하는 순간은 SQL client가 prompt로 돌아온 때가 아니라, 고객 경로와 background 작업이 정상임을 확인한 뒤다.

## 인덱스 설계와 maintenance를 구분하는 의사결정 표

| 관찰 | 먼저 검토할 질문 | 우선 대응 |
| --- | --- | --- |
| index size만 증가 | table row도 같은 비율로 증가하는가 | 추세 관찰, 정상 성장과 비교 |
| delete 뒤 파일이 큼 | retention·vacuum·long transaction은 정상인가 | cleanup·vacuum 원인 조사 |
| query가 느림 | plan이 target index를 쓰며 buffer/I/O가 문제인가 | EXPLAIN과 통계·query 설계 검토 |
| write가 느림 | 불필요·중복 index 또는 checkpoint가 있는가 | index inventory·write path 검토 |
| index 손상 의심 | 오류·invalid 상태·hardware evidence가 있는가 | 공식 복구 절차와 DBA escalation |
| 명확한 index bloat | 공간·lock·window가 준비됐는가 | 좁은 REINDEX 계획과 검증 |

이 표의 목적은 REINDEX를 피하는 것이 아니라, 문제에 맞는 도구를 쓰는 것이다. 예를 들어 중복 index가 write 부하의 원인이라면 재구성보다 drop 검토가 맞을 수 있고, retention table의 대량 삭제가 반복된다면 partitioning·archival 전략이 더 근본적일 수 있다. 반대로 하나의 주요 B-tree index가 명확한 비대 패턴을 보이고 online workload를 유지해야 한다면 concurrent reindex가 합리적일 수 있다.

## 운영 기록을 다음 판단에 쓰기

maintenance가 끝날 때마다 before·after size, elapsed time, WAL·disk 관찰, lock wait, replica 영향, application smoke 결과, 남은 위험을 같은 양식으로 저장한다. 여러 실행 뒤에는 어떤 테이블이 반복 후보인지, 어느 시간대에 작업이 안전한지, 어떤 index는 재구성해도 변화가 작았는지를 비교할 수 있다. 단일 실행의 성공담보다 이런 누적 기록이 PostgreSQL maintenance를 예측 가능한 작업으로 만든다.

자동화를 고려한다면 먼저 "매월 모든 index" 같은 scheduler부터 만들지 않는다. 후보를 찾는 read-only report, owner 검토, capacity preflight, 승인된 대상만 실행하는 job, 결과 reconciliation 순으로 나눈다. 자동 job에는 대상 개수·최대 index size·동시 실행 수·disk threshold·maintenance window를 제한해 오작동 범위를 작게 만든다. 데이터베이스 정비에서 가장 좋은 자동화는 가장 많은 명령을 실행하는 자동화가 아니라, 안전하지 않은 조건에서는 실행하지 않고 사람에게 충분한 근거를 주는 자동화다.

작업 결과는 SQL 로그와 monitoring screenshot만 남기는 데 그치지 않는다. 어떤 업무 지표를 확인했고, 어느 팀이 승인했으며, 다음 검토가 언제 필요한지까지 기록해야 같은 대상에 대한 다음 maintenance가 추측이 아니라 이력 기반 판단이 된다.

## 한계와 적용 기준 Q&A

## 버전과 배포 방식별 확인 사항

PostgreSQL의 maintenance 명령은 major version에 따라 지원 범위와 세부 동작이 달라질 수 있다. 이 글에서 링크한 current documentation은 개념과 최신 reference를 확인하는 출발점이지만, production 서버가 PostgreSQL 14·15·16·17 같은 다른 version이라면 해당 version의 문서를 다시 열어야 한다. cloud managed service를 쓴다면 superuser 권한, extension 설치, progress view, parameter 변경, maintenance window에 제공자 제한이 추가될 수 있다.

특히 managed database에서 storage auto-scaling이 있다고 해서 concurrent reindex의 공간 계획이 불필요해지는 것은 아니다. scaling이 완료되기 전의 I/O 영향, 비용 증가, replica storage, backup window를 함께 확인한다. 운영 절차에는 database engine version, provider, instance class, primary·replica topology, connection endpoint, 사용한 SQL client를 기록한다. 이 정보가 있어야 같은 runbook이 다른 환경에서 그대로 안전한지 판단할 수 있다.

### connection pool과 deploy pipeline 확인

REINDEX CONCURRENTLY는 transaction block 제약 때문에 애플리케이션 migration pipeline과 맞지 않을 수 있다. ORM migration, schema management tool, CI deployment script가 여러 SQL을 하나의 BEGIN/COMMIT으로 묶는지 확인한다. 명령이 transaction 안에서 실패한 뒤, 파이프라인이 나머지 migration을 어떤 상태로 처리하는지도 test environment에서 확인한다. maintenance SQL을 application release와 같은 job에 넣을지, 별도 DBA change로 실행할지도 영향도에 따라 결정한다.

connection pool이 긴 transaction을 만들거나 deploy 시 connection을 한꺼번에 재시작하면 maintenance 관찰이 어려워질 수 있다. 작업 window에는 대형 deployment·bulk import·data migration을 겹치지 않게 하고, application owner가 DB connection error와 endpoint latency를 바로 확인할 수 있게 한다. database 명령의 성공과 application availability는 서로 다른 검증 단계다.

## 사전 점검 쿼리를 운영 기준으로 바꾸기

read-only size query를 가끔 수동 실행하는 것보다, 큰 relation의 size·증가율·index scan·vacuum 관련 신호를 일정 주기로 수집해 dashboard로 보는 편이 조기 판단에 도움이 된다. 단, 모든 catalog 통계를 무제한 세밀도로 저장하면 monitoring database도 커진다. 상위 N개 relation, 최근 급증한 relation, 중요한 업무 테이블부터 시작해 retention을 둔다.

대시보드의 경고는 "index가 10GB" 같은 절대값 하나보다, 예상치보다 빠른 증가·disk 여유 하락·vacuum 지연·query latency 변화가 함께 보일 때 발화하도록 설계한다. 절대 크기는 서비스 규모에 따라 정상일 수 있다. 또한 index size가 줄지 않았다고 자동으로 alert를 내기보다, 어떤 maintenance hypothesis를 검증하려는지와 업무 영향이 무엇인지를 owner가 판단하도록 한다.

이 관찰은 REINDEX 후보를 자동 실행하는 트리거가 아니라, 사람이 검토할 근거를 만드는 단계다. index와 data는 고객 서비스의 핵심 자산이므로, shrink를 목표로 한 자동화가 예상과 다른 workload에 영향을 주지 않도록 승인 경계를 유지한다.

### Q. 정기적으로 모든 PostgreSQL 인덱스를 REINDEX하면 예방이 되나요?

A. 보통은 권장할 수 없다. 일부 B-tree workload에서는 주기적 reindex가 공간 사용과 접근 패턴에 도움이 될 수 있지만, 모든 index가 같은 pattern을 갖지 않는다. 넓은 작업은 I/O·디스크·운영 위험을 키운다. 크기 추세, 삭제·update pattern, query 영향, 유지보수 창을 근거로 후보를 좁히고, 한 대상씩 결과를 확인하는 편이 낫다.

### Q. `REINDEX CONCURRENTLY`면 transaction block 안에서 실행해도 되나요?

A. 명령 형태와 PostgreSQL version별 제약을 확인해야 하며, 일반적으로 concurrent maintenance 명령은 transaction block에서 실행할 수 없는 경우가 있다. migration tool이나 deploy script가 자동으로 transaction을 시작하는지 반드시 확인한다. 이 글의 SQL은 개념 예시이므로, 실제 실행 전 사용하는 major version의 공식 `REINDEX` reference를 확인한다.

### Q. 크기가 줄지 않으면 작업이 실패한 건가요?

A. 아니다. 데이터가 정상적으로 커졌거나, 대상 index의 비대가 크지 않았거나, 측정 시점의 workload가 달랐을 수 있다. 작업 성공 여부는 command 결과, index validity, application query의 정상 동작, lock·오류·복제 상태로 먼저 판단한다. 크기 변화는 원래 가설을 검증하는 하나의 지표일 뿐이다.

### Q. 비대 추정 extension을 production에서 바로 실행해도 되나요?

A. extension의 접근 권한, 실행 비용, version 지원 범위를 먼저 확인해야 한다. 큰 relation을 검사하는 작업은 자체 부하를 만들 수 있다. read replica나 비피크 시간에서 시험하고, 추정값을 단독 결정 근거로 쓰지 않는다. 운영 환경의 extension 설치는 보안·change 관리 절차도 따른다.

## 실무 점검 목록

- 대상 index가 크다는 사실 외에 증가 추세·삭제 패턴·query 사용 근거가 있는가?
- primary key, unique constraint, foreign key, partition index와의 관계를 확인했는가?
- PostgreSQL major version에서 대상 `REINDEX ... CONCURRENTLY` 형식과 제약을 확인했는가?
- concurrent build에 필요한 디스크 여유와 I/O 여력을 계산했는가?
- long transaction·lock wait·대량 batch·schema migration 일정을 확인했는가?
- 대상 하나부터 test 또는 작은 범위에서 절차를 검증했는가?
- 실행 중 disk, lock, replication lag, application 오류를 관찰할 수 있는가?
- 완료 뒤 index validity, query plan, 오류율, size 추세를 기록하는가?

## 마무리

PostgreSQL 인덱스 비대는 파일이 커졌다는 한 줄로 진단할 문제가 아니다. B-tree의 쓰기·삭제 패턴, MVCC와 vacuum, query usage, 디스크 여유, 운영 window를 함께 읽어야 한다. `REINDEX`는 손상·공간 비효율·storage parameter 변경을 다루는 유용한 도구지만, 잘못된 index 설계나 autovacuum 지연, storage 병목을 자동으로 고치지는 않는다.

운영에서의 좋은 시작은 가장 큰 index를 즉시 재구성하는 것이 아니라, 크기와 사용량의 추세를 기록하고 근거가 명확한 index 하나를 고르는 것이다. 그 다음 version별 제약과 lock·공간·복구 계획을 확인하고 `REINDEX CONCURRENTLY`를 좁게 검증한다. 대상과 결과를 기록하는 습관이 쌓이면, 정기 maintenance는 두려운 대형 작업이 아니라 workload에 맞춘 예측 가능한 운영 절차가 된다.

<h3 class="references-heading">참고 자료</h3>

- [PostgreSQL: Routine Reindexing](https://www.postgresql.org/docs/current/routine-reindex.html)
- [PostgreSQL: REINDEX SQL command](https://www.postgresql.org/docs/current/sql-reindex.html)
- [PostgreSQL: Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html)
- [PostgreSQL: Monitoring Database Activity](https://www.postgresql.org/docs/current/monitoring-stats.html)
- [PostgreSQL: Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html)
