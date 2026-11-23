---
layout: post
title: "MySQL Online DDL로 운영 중 스키마를 바꾸는 법: INSTANT·INPLACE·COPY 알고리즘과 메타데이터 락 대기 진단"
categories: [DBA]
tags: [dba, mysql, innodb, online-ddl, alter-table, metadata-lock, instant-ddl, schema-change]
description: "MySQL InnoDB의 ALTER TABLE이 서비스를 막는 이유를 기반 개념부터 설명하고, INSTANT·INPLACE·COPY 알고리즘의 차이, 메타데이터 락 대기 사슬 진단, 진행률 모니터링, 복제 지연 점검, 외부 도구 선택 기준을 조회 쿼리와 함께 정리합니다."
---

## 먼저 답하기

### Q. 운영 중인 테이블에 컬럼을 추가해도 서비스가 멈추지 않나요?

A. MySQL 8.0의 InnoDB(MySQL의 기본 스토리지 엔진)에서는 많은 `ALTER TABLE`이 **Online DDL(Data Definition Language, 테이블 구조를 바꾸는 SQL)** 로 실행됩니다. 변경하는 동안에도 해당 테이블에 `SELECT`, `INSERT`, `UPDATE`, `DELETE`를 계속 보낼 수 있다는 뜻입니다. 다만 "온라인"이라는 이름이 "무조건 안전"을 뜻하지는 않습니다. 변경 종류에 따라 데이터를 전혀 건드리지 않는 `INSTANT`, 테이블 안에서 다시 쓰는 `INPLACE`, 새 테이블로 통째로 복사하는 `COPY` 중 하나가 선택되고, 어느 쪽이든 시작과 끝에 짧은 **메타데이터 락(Metadata Lock, MDL)** 이 필요합니다. 이 짧은 락이 오래 걸리는 트랜잭션 뒤에 줄을 서면 그 뒤의 모든 쿼리가 함께 멈추는 사고가 생깁니다.

### Q. 그래서 무엇을 확인하고 실행해야 하나요?

A. 세 가지를 습관으로 만드는 것이 이 글의 결론입니다. 첫째, `ALTER TABLE` 문에 `ALGORITHM=INSTANT`처럼 알고리즘과 `LOCK=NONE`을 **명시**해서, 서버가 지원하지 않으면 조용히 느린 방식으로 넘어가지 않고 즉시 오류를 내게 합니다. 둘째, 실행 전에 `information_schema.innodb_trx`와 `performance_schema.metadata_locks`로 오래 열려 있는 트랜잭션이 없는지 확인합니다. 셋째, 실행 중에는 `performance_schema.events_stages_current`로 진행률을, 복제 환경이라면 복제 지연을 함께 봅니다. 이 글의 쿼리와 수치는 개념 설명을 위한 가정 예시이며, 특정 운영 환경에서 직접 측정한 결과가 아닙니다. 실제 지원 범위는 사용하는 MySQL 버전의 공식 문서로 확인해야 합니다.

## 먼저 알아둘 기반 기술

이 절은 본문을 이해하는 데 필요한 사전 개념을 가장 밑바닥부터 쌓아 올립니다. 테이블이 디스크에 어떻게 저장되는지에서 시작해, 락, 메타데이터 락, 트랜잭션과 다중 버전 동시성 제어, 그리고 변경 내용을 기록하고 전파하는 로그와 복제로 이어집니다. 각 소절 끝에 그 개념이 본문의 어느 절에서 쓰이는지 적었고, 마지막 표로 전체 연결을 정리했습니다.

### 테이블 저장 구조: 페이지와 클러스터드 인덱스

InnoDB는 데이터를 **페이지(page)** 라는 고정 크기 덩어리(기본 16KB)에 담아 디스크에 저장합니다. 그리고 테이블의 행(row)은 기본 키(Primary Key) 순서의 B-트리(균형 잡힌 트리 구조의 인덱스)에 저장되는데, 이를 **클러스터드 인덱스(clustered index)** 라고 합니다. 책으로 비유하면 본문 페이지가 쪽 번호순으로 꽂혀 있는 것이 클러스터드 인덱스이고, 맨 뒤의 찾아보기가 보조 인덱스입니다. 보조 인덱스는 기본 키 값을 들고 있다가 그 값으로 본문을 다시 찾아갑니다.

이 구조를 알아야 하는 이유는, 컬럼 추가·삭제나 기본 키 변경이 "행의 모양을 바꾸는 일"이어서 모든 페이지를 다시 써야 할 수도 있고, 인덱스 추가는 새 B-트리를 만들어 붙이는 일이어서 기존 행은 건드리지 않는다는 차이가 여기서 나오기 때문입니다. 이 개념은 아래 「알고리즘 세 가지: INSTANT, INPLACE, COPY」 절에서 알고리즘별 작업량 차이를 설명하는 근거로, 「진행률 모니터링」 절에서 어떤 단계가 오래 걸리는지 읽는 기준으로 쓰입니다.

### 락과 동시성: 공유 락과 배타 락

**락(lock)** 은 여러 세션이 같은 자원을 동시에 바꾸다 서로 망가뜨리지 않게 하는 잠금 장치입니다. 크게 읽기만 허용하는 **공유 락(shared lock, S)** 과 쓰기까지 독점하는 **배타 락(exclusive lock, X)** 이 있습니다. 공유 락끼리는 함께 걸릴 수 있지만 배타 락은 누구와도 함께 걸릴 수 없습니다. 화장실에 비유하면 공유 락은 여러 사람이 함께 쓰는 세면대이고, 배타 락은 문을 잠그고 쓰는 칸입니다.

DDL에서 이 개념이 중요한 이유는 `ALTER TABLE` 문의 `LOCK` 절이 바로 "변경 중 다른 세션에게 어느 수준까지 허용할 것인가"를 정하기 때문입니다. `LOCK=NONE`은 읽기·쓰기를 모두 허용하고, `LOCK=SHARED`는 읽기만, `LOCK=EXCLUSIVE`는 아무것도 허용하지 않습니다. 이 개념은 아래 「알고리즘 세 가지: INSTANT, INPLACE, COPY」 절과 「실습: 알고리즘과 락을 명시해 실행하기」 절에서 `LOCK` 절의 의미로 쓰입니다.

### 트랜잭션과 MVCC

**트랜잭션(transaction)** 은 여러 SQL을 "모두 성공하거나 모두 취소되는" 하나의 작업 단위로 묶은 것입니다. `START TRANSACTION`으로 시작하고 `COMMIT` 또는 `ROLLBACK`으로 끝납니다. InnoDB는 **MVCC(Multi-Version Concurrency Control, 다중 버전 동시성 제어)** 로 읽는 쪽이 쓰는 쪽을 막지 않게 합니다. 행을 수정할 때 이전 버전을 언두 로그(undo log)에 남겨 두고, 읽는 트랜잭션은 자기 시작 시점의 버전을 읽습니다.

여기서 핵심은 **트랜잭션이 끝나기 전에는 그 트랜잭션이 건드린 테이블의 메타데이터 락이 풀리지 않는다**는 점입니다. 단순 `SELECT` 하나를 실행하고 `COMMIT`을 잊은 채 열어 둔 세션이 있다면, 그 세션은 해당 테이블에 대한 공유 메타데이터 락을 계속 쥐고 있습니다. 이 개념은 아래 「메타데이터 락 대기 사슬 진단」 절의 사고 시나리오와 진단 쿼리, 「업무 예시: 주문 테이블에 컬럼 추가하기」 절의 실행 전 점검 쿼리로 쓰입니다.

### 메타데이터 락(MDL)

**메타데이터 락(Metadata Lock, MDL)** 은 테이블의 정의(스키마) 자체를 보호하는 락입니다. 앞에서 본 행 락이 "행의 내용"을 보호한다면, MDL은 "테이블의 모양"을 보호합니다. 어떤 세션이 테이블을 쿼리하는 동안에는 공유 MDL이 걸리고, `ALTER TABLE`은 시작과 끝에서 배타 MDL을 요청합니다. 배타 MDL은 기존 공유 MDL이 모두 풀릴 때까지 기다리는데, 그동안 **새로 들어오는 쿼리도 이 대기 줄 뒤에 서서 막힙니다**. 식당에서 단체 손님이 자리를 기다리는 동안 뒤에 온 일행들도 입구에서 같이 기다리는 모습과 비슷합니다.

이 개념을 모르면 "Online DDL이라 안전하다고 들었는데 왜 서비스 전체가 멈췄는가"를 설명할 수 없습니다. 이 개념은 아래 「메타데이터 락 대기 사슬 진단」 절에서 사고 원리와 진단 쿼리로, 「실습: 알고리즘과 락을 명시해 실행하기」 절에서 `lock_wait_timeout` 설정으로 쓰입니다.

### 바이너리 로그와 복제

**바이너리 로그(binary log, binlog)** 는 데이터 변경을 순서대로 기록한 로그이고, **복제(replication)** 는 이 로그를 다른 서버(레플리카)가 받아 같은 순서로 다시 실행해 데이터를 똑같이 유지하는 구조입니다. 원본 서버에서 실행한 `ALTER TABLE`도 binlog에 기록되어 레플리카에서 다시 실행됩니다. 레플리카는 보통 변경을 한 줄로 순서대로 적용하므로, 원본에서 오래 걸린 DDL은 레플리카에서도 비슷하게 오래 걸리고, 그동안 뒤따르는 변경이 밀립니다. 이 밀림을 **복제 지연(replication lag)** 이라고 부릅니다.

이 개념은 아래 「복제 환경과 롤백 계획」 절에서 복제 지연을 미리 확인하고 레플리카 영향을 설계하는 근거로 쓰입니다.

### 기반 개념 연결 지도

| 기반 개념 | 쓰이는 본문 절 | 그 절에서의 역할 |
| --- | --- | --- |
| 페이지·클러스터드 인덱스 | 알고리즘 세 가지: INSTANT, INPLACE, COPY | 변경 종류별 작업량 차이를 설명 |
| 페이지·클러스터드 인덱스 | 진행률 모니터링 | 단계 이름과 작업량 해석 |
| 락(S/X)·LOCK 절 | 알고리즘 세 가지: INSTANT, INPLACE, COPY | LOCK 절의 의미 |
| 락(S/X)·LOCK 절 | 실습: 알고리즘과 락을 명시해 실행하기 | 허용하지 않는 조합을 오류로 확인 |
| 트랜잭션·MVCC | 메타데이터 락 대기 사슬 진단 | 열린 트랜잭션이 MDL을 쥐는 원리 |
| 트랜잭션·MVCC | 업무 예시: 주문 테이블에 컬럼 추가하기 | 실행 전 장기 트랜잭션 점검 |
| 메타데이터 락 | INPLACE DDL의 세 단계와 락이 걸리는 순간 | 준비·커밋 단계의 배타 MDL 요청 시점을 시간 순서로 설명 |
| 페이지·클러스터드 인덱스 | INSTANT 컬럼 추가는 무엇을 바꾸고 무엇을 남기는가 | 행을 고치지 않고 정의만 바꾸는 원리와 행 버전 한도 |
| 페이지·클러스터드 인덱스 | 변경 방식을 고르는 의사결정 순서 | 테이블 크기로 작업량을 가늠 |
| 메타데이터 락 | 메타데이터 락 대기 사슬 진단 | 대기 줄이 서비스 전체를 막는 현상과 진단 |
| 메타데이터 락 | 실습: 알고리즘과 락을 명시해 실행하기 | lock_wait_timeout으로 대기 상한 설정 |
| 바이너리 로그·복제 | 복제 환경과 롤백 계획 | 레플리카 지연과 적용 순서 확인 |
| 바이너리 로그·복제 | 외부 도구를 선택하는 기준 | 복제 환경에서 외부 도구의 부담 비교 |

## 알고리즘 세 가지: INSTANT, INPLACE, COPY

`ALTER TABLE`이 어떻게 실행되는지는 **알고리즘(ALGORITHM)** 으로 정해집니다. 앞서 기반 기술에서 본 클러스터드 인덱스 관점에서 정리하면 다음과 같습니다.

- **INSTANT**: 테이블 데이터를 다시 쓰지 않고 데이터 사전(data dictionary, 테이블 정의를 저장한 내부 메타데이터)만 바꿉니다. 테이블 크기와 상관없이 거의 즉시 끝납니다. 8.0 공식 문서 기준으로 컬럼 추가, 기본값 변경, 일부 컬럼 속성 변경 등 일부 작업만 지원하며, 지원 범위는 8.0 부수 버전에 따라 넓어져 왔습니다.
- **INPLACE**: 테이블을 통째로 새 파일로 복사하지는 않지만, 필요하면 기존 행이나 인덱스를 다시 만듭니다. 보조 인덱스 추가가 대표적이고, 변경 동안 들어온 DML(`INSERT`·`UPDATE`·`DELETE`)은 **온라인 로그**에 모아 두었다가 마지막에 반영합니다.
- **COPY**: 새 구조의 임시 테이블을 만들어 모든 행을 복사한 뒤 이름을 바꿔 치환합니다. 복사하는 동안 쓰기가 막히는 것이 보통이고 가장 비쌉니다.

그림으로 정리하면 아래와 같습니다. 세 알고리즘 모두 시작과 끝에 짧은 메타데이터 락 구간이 있다는 점을 눈여겨보세요.

<figure class="article-figure"><img src="{{ '/assets/images/mysql-online-ddl-algorithms.svg' | relative_url }}" alt="INSTANT는 메타데이터만 변경하고 INPLACE는 온라인 로그를 쌓은 뒤 반영하며 COPY는 새 테이블로 복사 후 교체하는 흐름과 모든 알고리즘의 시작과 끝에 있는 메타데이터 락 구간"><figcaption>그림. 세 알고리즘의 작업 범위 비교. 모두 시작·끝에 짧은 배타 메타데이터 락이 필요하다. 이미지 출처: 직접 제작</figcaption></figure>

| 구분 | INSTANT | INPLACE | COPY |
| --- | --- | --- | --- |
| 데이터 재작성 | 하지 않음 | 일부 또는 전체(작업에 따라) | 전체를 새 테이블로 복사 |
| 변경 중 DML | 허용 | 대부분 허용(`LOCK=NONE` 가능한 작업) | 읽기만 허용되는 것이 일반적 |
| 소요 시간 | 테이블 크기와 거의 무관 | 크기와 인덱스 수에 비례 | 크기에 비례, 가장 김 |
| 추가 디스크 | 거의 없음 | 온라인 로그·정렬 임시 공간 | 새 테이블 크기만큼 |
| 대표 작업 | 컬럼 추가, 컬럼 기본값 변경 | 보조 인덱스 추가, 컬럼 이름 변경 등 | 컬럼 데이터 타입 변경 등 |

작업별로 어떤 알고리즘이 가능한지는 공식 문서의 "Online DDL Operations" 표가 기준입니다. 표에는 `In Place`, `Rebuilds Table`, `Permits Concurrent DML`, `Only Modifies Metadata` 열이 있으므로, 변경 전에 해당 행을 직접 확인하는 습관이 필요합니다.

## 실습: 알고리즘과 락을 명시해 실행하기

`ALGORITHM`과 `LOCK`을 쓰지 않으면 서버가 가능한 방식 중에서 알아서 고릅니다. 이는 편하지만, 의도와 다른 방식으로 실행되어도 모르고 지나갈 위험이 있습니다. 명시하면 지원하지 않는 경우 **실행 전에 오류**가 나서, 큰 테이블을 복사해 버리는 사고를 막아 줍니다. 아래는 실습용 테이블입니다.

```sql
CREATE TABLE orders (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  customer_id BIGINT NOT NULL,
  status VARCHAR(20) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  created_at DATETIME NOT NULL
) ENGINE=InnoDB;
```

컬럼 추가는 `INSTANT`를 먼저 시도합니다. 지원하지 않는 경우 오류가 나므로 다음 단계로 넘어갈지 판단할 수 있습니다.

```sql
SET SESSION lock_wait_timeout = 10;   -- MDL 대기를 10초로 제한

ALTER TABLE orders
  ADD COLUMN coupon_code VARCHAR(30) NULL,
  ALGORITHM=INSTANT;
```

보조 인덱스는 `INPLACE`와 `LOCK=NONE`을 함께 지정합니다.

```sql
ALTER TABLE orders
  ADD INDEX idx_orders_customer_created (customer_id, created_at),
  ALGORITHM=INPLACE, LOCK=NONE;
```

데이터 타입 변경처럼 `INPLACE`가 허용되지 않는 작업에 이 조합을 쓰면 다음과 같은 오류가 납니다. 오류 메시지는 버전에 따라 다를 수 있습니다.

```text
ERROR 1846 (0A000): ALGORITHM=INPLACE is not supported.
Reason: Cannot change column type INPLACE. Try ALGORITHM=COPY.
```

이 오류는 실패가 아니라 **안전장치가 작동한 것**입니다. 이때는 변경 시간을 정해 점검 창을 잡거나, 뒤에서 볼 외부 도구를 검토하면 됩니다. 앞서 기반 기술에서 본 메타데이터 락 개념과 이어 보면, `lock_wait_timeout`은 "배타 MDL을 얻기 위해 최대 몇 초까지 줄을 서겠는가"를 정합니다. 10초 안에 락을 얻지 못하면 DDL이 포기하고 오류로 끝나므로, 뒤따르는 쿼리를 오래 붙잡지 않습니다.

## INSTANT 컬럼 추가는 무엇을 바꾸고 무엇을 남기는가

`INSTANT`가 빠른 이유는 기존 행을 하나도 고치지 않기 때문입니다. 앞서 기반 기술에서 본 클러스터드 인덱스의 페이지들은 그대로 두고, 데이터 사전에 "이 테이블에는 새 컬럼이 있고 기본값은 이것"이라는 정보만 기록합니다. 나중에 옛 행을 읽을 때 서버가 새 컬럼 값이 비어 있으면 기록된 기본값을 채워서 돌려줍니다. 새 컬럼이 있는 행은 이후 `INSERT`나 `UPDATE`가 일어날 때 자연스럽게 새 형태로 저장됩니다. 도서관의 서가를 다시 정리하지 않고, 안내 책자에 "신간 칸이 생겼다"는 메모만 붙여 두는 것과 비슷합니다.

이 방식에는 대가가 있습니다. 한 테이블 안에 서로 다른 구조의 행이 섞이게 되므로, 서버는 각 행이 어느 버전의 구조인지를 구분해 해석해야 합니다. MySQL 8.0 문서는 이를 행 버전(row version)으로 설명하며, 즉시 추가·삭제를 반복할 수 있는 횟수에 한도가 있다고 밝힙니다. 한도에 도달하면 테이블을 한 번 다시 만들어(rebuild) 버전을 정리해야 합니다. 그래서 `INSTANT`가 가능하다고 해서 임시 컬럼을 수시로 넣었다 빼는 설계는 권하지 않습니다. 구체적인 상한과 조건은 버전에 따라 다르므로 사용 중인 버전의 문서에서 "Instant" 항목을 확인해야 합니다.

```sql
-- 최근 INSTANT 변경이 얼마나 쌓였는지 대략 확인하는 방법(8.0 이상)
SELECT NAME, TOTAL_ROW_VERSIONS
FROM information_schema.INNODB_TABLES
WHERE NAME = 'shop/orders';
```

위 조회에서 `TOTAL_ROW_VERSIONS` 열이 보이지 않는다면 사용 중인 부수 버전에서 지원하지 않는 것이므로 무시하고 공식 문서의 제한 항목만 참고하면 됩니다.

## INPLACE DDL의 세 단계와 락이 걸리는 순간

앞서 기반 기술에서 본 락과 메타데이터 락 개념을 DDL 한 번의 시간 순서로 펼쳐 보면, `INPLACE` 방식의 Online DDL은 크게 준비, 실행, 커밋 세 단계로 나뉩니다. 이 구분을 알면 "어느 순간에 쿼리가 막히는가"를 정확히 짚을 수 있습니다.

**준비 단계(prepare)** 에서는 서버가 해당 테이블의 배타 MDL을 잠깐 얻어 변경이 가능한지 확인하고, 사용할 알고리즘과 락 수준을 확정합니다. 이 단계에서 앞서 지정한 `ALGORITHM`·`LOCK` 조합이 지원되지 않으면 오류가 납니다. 준비가 끝나면 배타 MDL은 공유 수준으로 내려가, 다른 세션이 읽고 쓸 수 있게 됩니다. 공식 문서는 이 전환을 MDL의 업그레이드·다운그레이드로 설명합니다.

**실행 단계(execute)** 에서 실제 작업이 이루어집니다. 보조 인덱스 추가라면 클러스터드 인덱스를 읽어 정렬한 뒤 새 인덱스의 B-트리를 만듭니다. 이 시간이 테이블 크기에 비례해 길어지는 구간이고, 뒤에서 볼 진행률 모니터링에서 `read PK and internal sort`, `merge sort`, `insert` 같은 단계 이름이 보이는 때가 바로 여기입니다. 이 동안 다른 세션의 `INSERT`·`UPDATE`·`DELETE`는 정상 처리되며, 변경 내용은 **온라인 로그(row log)** 라는 임시 버퍼에 쌓입니다. 이 로그는 크기에 상한이 있어 쓰기가 매우 많으면 가득 찰 수 있습니다.

**커밋 단계(commit)** 에서는 서버가 다시 배타 MDL을 요청합니다. 온라인 로그에 쌓인 변경을 마지막으로 반영하고, 새 정의를 데이터 사전에 기록한 뒤 락을 풉니다. 아래에서 다룰 대기 사슬 사고는 이 시작·끝 두 번의 배타 MDL 요청에서 일어납니다. 준비 단계의 요청은 앞선 쿼리들이 끝날 때까지, 커밋 단계의 요청은 실행 도중에 열린 트랜잭션들이 끝날 때까지 기다리기 때문입니다. 실행 단계가 길수록 그 사이에 새로 열린 트랜잭션이 많아지므로, **오래 걸리는 DDL일수록 마지막 락 대기에 걸릴 가능성도 높아진다**는 점을 기억해 둘 필요가 있습니다.

| 단계 | 필요한 MDL | 다른 세션의 DML | 병목이 되는 경우 |
| --- | --- | --- | --- |
| 준비 | 배타 → 공유로 전환 | 짧은 대기 후 허용 | 오래 열린 트랜잭션이 공유 MDL을 쥔 경우 |
| 실행 | 공유 수준 유지 | 허용(온라인 로그에 기록) | 온라인 로그 한도 초과, 디스크·I/O 부족 |
| 커밋 | 다시 배타로 승격 | 짧게 대기 | 실행 중 시작된 트랜잭션이 아직 열려 있는 경우 |

`INSTANT` 알고리즘에는 실행 단계가 사실상 없고, 준비와 커밋의 짧은 구간만 있다고 이해하면 됩니다. 그래서 `INSTANT`는 빠르지만, 오래 열린 트랜잭션이 있으면 똑같이 MDL 대기에 걸립니다. "즉시 끝나는 변경이니 걱정 없다"는 인식이 가장 흔한 사고 원인이므로, 실행 전 점검 쿼리는 알고리즘과 무관하게 항상 수행해야 합니다.

## 변경 방식을 고르는 의사결정 순서

실제 변경 요청을 받았을 때 어떤 순서로 판단하는지 정리하면 다음과 같습니다. 이 순서를 팀의 변경 절차에 넣어 두면 개인의 경험에 의존하지 않고 같은 기준으로 판단할 수 있습니다.

1. **변경 종류를 분류합니다.** 컬럼 추가·삭제, 기본값 변경, 인덱스 추가·삭제, 타입 변경, 문자셋 변경, 기본 키 변경 중 무엇인지 적습니다.
2. **공식 문서 표에서 지원 방식을 찾습니다.** 사용 중인 MySQL의 부수 버전(예: 8.0.x) 문서에서 해당 작업의 `In Place`, `Rebuilds Table`, `Permits Concurrent DML`, `Only Modifies Metadata` 값을 확인합니다. 버전마다 `INSTANT` 지원 범위가 달라질 수 있으므로, 다른 버전을 다룬 블로그 글이 아니라 해당 버전 문서를 기준으로 삼아야 합니다.
3. **테이블 크기와 쓰기량을 확인합니다.** 아래 조회로 테이블의 대략적 크기를 봅니다. 값은 통계 기반 추정치이므로 절대값보다 자릿수를 보는 용도입니다.

```sql
SELECT TABLE_NAME, TABLE_ROWS,
       ROUND(DATA_LENGTH/1024/1024) AS data_mb,
       ROUND(INDEX_LENGTH/1024/1024) AS index_mb
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = 'shop' AND TABLE_NAME = 'orders';
```

4. **방식을 정합니다.** `INSTANT`로 가능하면 그대로 실행합니다. `INPLACE`·`LOCK=NONE`이면 낮은 트래픽 시간을 고르고 진행률과 복제 지연을 감시합니다. `COPY`만 가능하면 점검 창이나 외부 도구를 검토합니다.
5. **중단 기준과 복구 절차를 미리 적습니다.** 예를 들어 "복제 지연이 60초를 넘으면 중단" 같은 기준은 업무마다 허용 지연이 다르므로 서비스 요구에서 역산해 정합니다.

이렇게 정해 두면 새벽 장애 상황에서 판단할 사항이 줄어듭니다. 또한 앞서 기반 기술에서 본 페이지와 클러스터드 인덱스 관점으로 보면, 위 3번의 테이블 크기가 곧 `INPLACE`·`COPY`의 예상 작업량이라는 점이 이어집니다.

## 메타데이터 락 대기 사슬 진단

가장 흔한 사고 시나리오는 다음과 같습니다. 앞서 기반 기술에서 본 대로 트랜잭션이 끝나기 전에는 MDL이 풀리지 않습니다.

1. 세션 A가 `START TRANSACTION; SELECT ... FROM orders;` 후 `COMMIT` 없이 열려 있습니다. (공유 MDL 보유)
2. 세션 B가 `ALTER TABLE orders ...`를 시작합니다. (배타 MDL 대기)
3. 세션 C, D, E…가 `orders`를 조회하려 합니다. B 뒤에 줄을 서서 모두 `Waiting for table metadata lock` 상태가 됩니다.

원인을 찾는 첫 번째 조회는 현재 `orders`에 걸린 MDL과 대기 상태입니다. `performance_schema`의 `metadata_locks` 테이블을 씁니다.

```sql
SELECT ml.OBJECT_SCHEMA, ml.OBJECT_NAME, ml.LOCK_TYPE, ml.LOCK_STATUS,
       t.PROCESSLIST_ID, t.PROCESSLIST_STATE, t.PROCESSLIST_INFO
FROM performance_schema.metadata_locks ml
JOIN performance_schema.threads t ON t.THREAD_ID = ml.OWNER_THREAD_ID
WHERE ml.OBJECT_SCHEMA = 'shop' AND ml.OBJECT_NAME = 'orders'
ORDER BY ml.LOCK_STATUS, t.PROCESSLIST_ID;
```

`LOCK_STATUS`가 `GRANTED`인 행은 락을 쥔 세션이고, `PENDING`인 행은 기다리는 세션입니다. 보통 `GRANTED`인 공유 락 보유자가 원인이고, `PENDING`의 배타 락이 `ALTER TABLE`입니다. 단, 이 테이블은 해당 계측(instrument)이 켜져 있어야 채워지며, 8.0에서는 `wait/lock/metadata/sql/mdl`이 기본으로 켜져 있는 것이 일반적이지만 환경 설정에 따라 다를 수 있으니 확인이 필요합니다.

```sql
SELECT NAME, ENABLED FROM performance_schema.setup_instruments
WHERE NAME = 'wait/lock/metadata/sql/mdl';
```

두 번째 조회는 오래 열려 있는 트랜잭션입니다. 어떤 세션이 몇 초째 트랜잭션을 열어 두었는지 `information_schema.innodb_trx`로 봅니다.

```sql
SELECT trx_mysql_thread_id AS conn_id, trx_state,
       TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS open_sec,
       trx_query
FROM information_schema.innodb_trx
ORDER BY trx_started;
```

원인 세션을 찾았다면, 그 세션의 소유자에게 `COMMIT`/`ROLLBACK`을 요청하는 것이 먼저이고, 급할 때만 `KILL <conn_id>`로 연결을 끊습니다. `KILL`은 그 트랜잭션을 롤백시키므로 업무 영향이 없는지 확인하고 실행해야 합니다. 또한 MySQL 8.0의 `sys` 스키마에는 `sys.schema_table_lock_waits` 뷰가 있어 대기자와 차단자를 한 번에 보여 줍니다.

```sql
SELECT waiting_pid, waiting_query, blocking_pid, blocking_query, sql_kill_blocking_connection
FROM sys.schema_table_lock_waits
WHERE object_schema = 'shop' AND object_name = 'orders';
```

실제 현장에서는 DDL을 실행하기 전에 위 두 조회를 먼저 해서 "오래 열린 트랜잭션이 없는지"를 확인하고, 실행할 때는 `lock_wait_timeout`을 짧게 둬서 걸리면 포기하게 하는 것이 안전합니다.

## 진행률 모니터링

`INPLACE`나 `COPY`로 오래 걸리는 DDL은 얼마나 진행되었는지 확인할 수 있어야 합니다. `performance_schema`의 단계(stage) 계측을 켜면 `ALTER TABLE`의 진행량을 볼 수 있습니다. 앞서 본 클러스터드 인덱스와 보조 인덱스를 만드는 단계가 각각 별도 이름으로 나타납니다.

```sql
UPDATE performance_schema.setup_instruments
SET ENABLED = 'YES'
WHERE NAME LIKE 'stage/innodb/alter%';

UPDATE performance_schema.setup_consumers
SET ENABLED = 'YES'
WHERE NAME LIKE '%stages%';
```

DDL이 실행 중인 다른 세션이 있는 상태에서 아래를 조회하면 진행량이 나옵니다.

```sql
SELECT EVENT_NAME, WORK_COMPLETED, WORK_ESTIMATED,
       ROUND(100 * WORK_COMPLETED / NULLIF(WORK_ESTIMATED, 0), 1) AS pct
FROM performance_schema.events_stages_current;
```

```text
+------------------------------------------------------+----------------+----------------+------+
| EVENT_NAME                                           | WORK_COMPLETED | WORK_ESTIMATED | pct  |
+------------------------------------------------------+----------------+----------------+------+
| stage/innodb/alter table (read PK and internal sort) |         123456 |         500000 | 24.7 |
+------------------------------------------------------+----------------+----------------+------+
```

위 출력은 형식을 보여 주기 위한 가상의 예시입니다. `WORK_ESTIMATED`는 추정치이므로 100%가 정확한 완료 시각을 뜻하지는 않으며, 단계가 바뀌면 값이 다시 시작합니다. 계측을 켜는 것은 약간의 오버헤드가 있으므로 필요한 시간에만 켜고 끝나면 되돌리는 편이 좋습니다.

## 복제 환경과 롤백 계획

복제 환경에서는 원본 서버의 DDL이 binlog를 통해 레플리카에서도 실행됩니다. 앞서 기반 기술에서 본 대로 레플리카는 변경을 순서대로 적용하므로, 원본에서 30분 걸린 `INPLACE` 작업이 레플리카에서도 비슷한 시간을 쓰고 그동안 뒤따르는 변경이 밀립니다. 레플리카가 읽기 부하를 분담하고 있다면, 이 지연이 곧 사용자에게 오래된 데이터가 보이는 시간입니다. 실행 전후로 지연을 확인하는 쿼리를 준비해 둡니다.

```sql
SHOW REPLICA STATUS\G
-- Seconds_Behind_Source: 레플리카가 원본보다 몇 초 뒤처졌는지
-- Replica_SQL_Running_State: 지금 적용 중인 작업의 상태
```

롤백 계획은 두 갈래입니다. 하나는 변경 자체를 되돌릴 방법으로, 컬럼을 추가했다면 `DROP COLUMN`을 준비해 두고 어떤 알고리즘으로 가능한지 미리 확인해 두는 것입니다. 다른 하나는 애플리케이션 호환성입니다. 새 컬럼이 `NULL`을 허용하고 기본값이 있다면 이전 버전 코드도 계속 동작하므로, "스키마를 먼저 바꾸고 코드를 나중에 배포"하는 순서로 위험을 줄일 수 있습니다. `INSTANT`로 컬럼을 많이 추가·삭제하면 내부에 행 버전이 쌓이는데, 8.0 문서는 버전 수에 상한이 있다고 설명하므로 반복 변경이 잦은 테이블은 문서의 제한 항목을 확인하는 것이 좋습니다.

## 외부 도구를 선택하는 기준

`INPLACE`가 지원되지 않거나 서비스 영향을 더 세밀하게 조절하고 싶다면 외부 도구가 대안입니다. 대표적으로 Percona의 `pt-online-schema-change`와 GitHub이 공개한 `gh-ost`가 있습니다. 두 도구는 모두 새 구조의 "그림자 테이블"을 만들고 기존 데이터를 조금씩 복사하면서 그동안의 변경을 따라잡은 뒤 마지막에 이름을 바꿔 치환합니다. `pt-online-schema-change`는 테이블에 트리거를 달아 변경을 따라잡고, `gh-ost`는 트리거 대신 binlog를 읽어 따라잡는다는 점이 다릅니다.

| 구분 | 네이티브 Online DDL | pt-online-schema-change | gh-ost |
| --- | --- | --- | --- |
| 변경 방식 | 서버 내장 | 그림자 테이블 + 트리거 | 그림자 테이블 + binlog 읽기 |
| 서비스 영향 조절 | 제한적 | 청크 크기, 지연 감시 옵션 | 일시중지·스로틀링 가능 |
| 복제 환경 부담 | DDL이 그대로 복제됨 | 행 변경이 복제됨 | 행 변경이 복제됨 |
| 도입 비용 | 낮음(SQL만) | 별도 도구·권한 필요 | 별도 도구·binlog 설정 필요 |
| 적합한 때 | INSTANT·INPLACE 가능한 변경 | 네이티브가 어려운 변경 | 트리거 부담을 피하고 싶을 때 |

외부 도구는 "더 안전하다"기보다 "다른 종류의 위험을 지닌다"고 보는 편이 정확합니다. 도구의 동작 원리와 제약(외래 키, 트리거가 있는 테이블, 기본 키 유무 등)은 각 도구의 공식 문서를 확인한 뒤 스테이징 환경에서 먼저 연습해야 합니다. 이 글은 두 도구를 직접 운영해 본 경험을 바탕으로 쓴 것이 아니라 공식 문서의 설명을 정리한 것입니다.

## 업무 예시: 주문 테이블에 컬럼 추가하기

가정 시나리오입니다. 쇼핑몰 주문 테이블 `orders`에 쿠폰 코드를 저장할 `coupon_code` 컬럼을 추가하고, 고객별 최근 주문 조회를 빠르게 하는 인덱스도 추가해야 합니다. 서비스는 24시간 운영되며, 점검 창은 따로 없습니다.

**1단계: 변경을 두 개로 나눕니다.** 컬럼 추가는 `INSTANT`, 인덱스 추가는 `INPLACE`로 처리될 가능성이 높으므로 분리해 실행하면 각 단계의 위험을 따로 볼 수 있습니다.

**2단계: 실행 전 점검을 합니다.** 앞서 본 `innodb_trx` 조회로 5분 이상 열려 있는 트랜잭션이 없는지 확인합니다.

```sql
SELECT trx_mysql_thread_id, TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS open_sec
FROM information_schema.innodb_trx
WHERE trx_started < NOW() - INTERVAL 5 MINUTE;
```

**3단계: 대기 상한을 두고 실행합니다.** 락을 못 얻으면 포기하게 하고, 다른 시간에 재시도합니다.

```sql
SET SESSION lock_wait_timeout = 5;
ALTER TABLE orders ADD COLUMN coupon_code VARCHAR(30) NULL, ALGORITHM=INSTANT;
-- 실패(락 대기 시간 초과)하면 원인 트랜잭션을 확인하고 재시도
```

**4단계: 인덱스는 진행률과 복제 지연을 보며 실행합니다.** 인덱스 추가는 테이블 크기에 비례해 시간이 걸리므로, 트래픽이 낮은 시간대를 고르고 `events_stages_current`와 `SHOW REPLICA STATUS`를 번갈아 확인합니다.

**5단계: 사후 확인을 합니다.** 적용된 구조를 확인하고 애플리케이션 배포를 진행합니다.

```sql
SHOW CREATE TABLE orders\G
SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = 'shop' AND TABLE_NAME = 'orders';
```

이 흐름의 요점은 "한 번에 크게 바꾸지 않고, 명시하고, 확인하고, 포기할 수 있게 하는 것"입니다.

## 변경 전 점검 체크리스트

- 변경하려는 작업이 공식 문서의 Online DDL 표에서 어떤 알고리즘·락 수준을 지원하는지 확인했는가
- `ALGORITHM`과 `LOCK`을 명시해 지원하지 않으면 실행 전에 실패하도록 했는가
- 5분 이상 열려 있는 트랜잭션이 없는지 `innodb_trx`로 확인했는가
- `lock_wait_timeout`을 짧게 두었고, 실패 시 재시도 절차가 있는가
- `INPLACE`·`COPY`라면 추가 디스크 공간(온라인 로그·임시 파일·새 테이블)이 충분한가
- 복제 지연 임계값과, 지연이 넘으면 중단하는 기준을 정했는가
- 변경을 되돌릴 방법(`DROP COLUMN` 등)과 애플리케이션 호환 순서를 정했는가
- 스테이징 환경에서 같은 DDL을 먼저 실행해 시간을 가늠했는가

## 한계와 적용 기준 Q&A

### Q. `ALGORITHM=INSTANT`면 어떤 변경이든 즉시 끝나나요?

A. 아닙니다. `INSTANT`로 가능한 작업은 일부로 한정됩니다. 컬럼 추가, 기본값 변경처럼 데이터를 다시 쓰지 않아도 되는 작업이 대표적이고, 데이터 타입 변경이나 기본 키 변경은 지원하지 않습니다. 또한 지원 범위는 MySQL 버전에 따라 다르므로, 사용하는 버전의 문서를 확인해야 합니다. 명시했는데 지원하지 않으면 오류가 나므로, 시도해 보는 비용 자체는 낮습니다.

### Q. Online DDL 중에 정말로 쓰기가 전혀 막히지 않나요?

A. `LOCK=NONE`이 가능한 작업이라면 변경 중 DML이 허용됩니다. 그러나 시작과 끝의 짧은 배타 MDL 구간은 피할 수 없고, 앞서 본 것처럼 오래 열린 트랜잭션이 있으면 이 구간이 길어져 사실상 모든 쿼리를 막을 수 있습니다. `INPLACE`는 온라인 로그에 변경을 쌓아 두므로, 변경이 매우 많은 테이블은 로그 크기 한도(`innodb_online_alter_log_max_size`)를 넘어 DDL이 실패할 수도 있습니다.

### Q. 외부 도구가 네이티브 Online DDL보다 항상 낫나요?

A. 그렇지 않습니다. 네이티브 방식이 지원하는 변경이라면 도구 없이 SQL 한 줄로 끝나므로 더 단순하고 검증 범위도 좁습니다. 외부 도구는 네이티브로 불가능하거나, 서비스·복제에 주는 부하를 세밀하게 조절해야 할 때 고려하는 선택지입니다. 도구도 그림자 테이블 치환 시점에는 잠깐의 락이 필요하다는 점에서 위험이 사라지는 것은 아닙니다.

### Q. 실패하면 중간 상태가 남나요?

A. 네이티브 Online DDL은 실패하면 변경이 되돌려지고 원래 정의가 유지되는 것이 원칙입니다. 다만 `INPLACE`·`COPY`가 오래 진행된 뒤 실패하면 그동안 쓴 시간과 디스크 I/O가 모두 낭비되고, 롤백 자체에도 시간이 걸릴 수 있습니다. 그래서 큰 테이블은 사전에 지원 여부를 확인하고, 스테이징에서 먼저 시간을 재 두는 편이 좋습니다.

### Q. 언제 Online DDL을 쓰지 않는 편이 좋은가요?

A. 변경이 `COPY`로만 가능하고 테이블이 매우 크며 점검 창도 없다면, 단일 `ALTER TABLE`로 밀어붙이지 말고 외부 도구나 단계적 마이그레이션(새 테이블 생성, 이중 기록, 전환)을 검토합니다. 반대로 개발·테스트 환경이나 행이 적은 테이블이라면 단순한 `ALTER TABLE`이 가장 간단하므로 복잡한 방식을 굳이 쓸 필요가 없습니다.

## 마무리

Online DDL은 운영 중 스키마 변경의 위험을 크게 줄여 주지만, 핵심은 "알고리즘을 알고 쓰는 것"과 "메타데이터 락 대기 사슬을 의식하는 것"입니다. 알고리즘과 락 수준을 명시해 지원하지 않으면 실행 전에 멈추게 하고, 실행 전에 오래 열린 트랜잭션을 확인하고, `lock_wait_timeout`으로 대기 상한을 두고, 진행률과 복제 지연을 확인하는 네 가지 습관이면 대부분의 사고를 막을 수 있습니다. 지금 운영하는 테이블 하나를 골라 공식 문서의 Online DDL 표와 비교해 보는 것으로 시작해 보세요.

<h3 class="references-heading">참고 자료</h3>

- [MySQL 8.0 Reference Manual: Online DDL](https://dev.mysql.com/doc/refman/8.0/en/innodb-online-ddl.html)
- [MySQL 8.0 Reference Manual: Online DDL Operations](https://dev.mysql.com/doc/refman/8.0/en/innodb-online-ddl-operations.html)
- [MySQL 8.0 Reference Manual: Online DDL Performance and Concurrency](https://dev.mysql.com/doc/refman/8.0/en/innodb-online-ddl-performance.html)
- [MySQL 8.0 Reference Manual: Metadata Locking](https://dev.mysql.com/doc/refman/8.0/en/metadata-locking.html)
- [MySQL 8.0 Reference Manual: Monitoring ALTER TABLE Progress for InnoDB Tables Using Performance Schema](https://dev.mysql.com/doc/refman/8.0/en/monitor-alter-table-performance-schema.html)
- [MySQL 8.0 Reference Manual: ALTER TABLE Statement](https://dev.mysql.com/doc/refman/8.0/en/alter-table.html)
- [Percona Toolkit: pt-online-schema-change](https://docs.percona.com/percona-toolkit/pt-online-schema-change.html)
