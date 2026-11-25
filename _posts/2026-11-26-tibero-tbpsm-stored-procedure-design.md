---
layout: post
title: "Tibero tbPSM 저장 프로시저 설계와 운영: 블록 구조·예외 처리·커서·BULK 처리·오류 진단"
categories: [DBA]
tags: [tibero, tbpsm, stored-procedure, plsql, exception-handling, cursor, bulk-collect, dba]
description: "Tibero의 저장 프로시저 언어 tbPSM을 처음 다루는 DBA·개발자를 위해 블록 구조, 변수와 커서, 예외 처리, 트랜잭션 경계, 행 단위 처리와 집합 처리의 차이, BULK COLLECT·FORALL, 무효 객체 진단 쿼리와 운영 점검 기준을 실행 예시로 정리합니다."
---

## 먼저 답하기

### Q. tbPSM은 무엇이고, 일반 SQL과 무엇이 다른가요?

A. **tbPSM(Tibero Persistent Stored Module)** 은 Tibero 데이터베이스 서버 안에 프로그램을 저장하고 실행하게 해 주는 절차형 언어입니다. 일반 SQL은 "무엇을 가져올지"를 선언하는 한 문장짜리 명령이지만, tbPSM은 변수·조건문·반복문·예외 처리를 갖춘 프로그램 안에서 여러 SQL을 순서대로 실행합니다. 문법이 Oracle의 PL/SQL과 매우 비슷해서 PL/SQL을 아는 사람은 큰 어려움 없이 읽을 수 있습니다. 다만 두 제품은 같은 제품이 아니므로, 지원하는 구문·내장 패키지·뷰 이름은 설치한 Tibero 버전의 공식 문서로 확인해야 합니다. 이 글의 코드는 개념 설명을 위한 가정 예시이며, 직접 운영하거나 측정한 결과가 아닙니다.

### Q. 비즈니스 로직을 전부 프로시저로 옮기면 빨라지나요?

A. 항상 그렇지는 않습니다. 프로시저는 애플리케이션과 데이터베이스 사이의 왕복 횟수를 줄이고, 여러 SQL을 한 트랜잭션으로 묶는 데 강합니다. 하지만 프로시저 안에서 행을 한 건씩 반복 처리하면 오히려 느려질 수 있고, 로직이 데이터베이스에 흩어지면 버전 관리·테스트·배포가 어려워집니다. 프로시저는 "데이터와 가까이에서 일관되게 실행해야 하는 규칙"에 쓰고, 화면 흐름이나 외부 연동 같은 로직은 애플리케이션에 두는 균형이 필요합니다.

## 먼저 알아둘 기반 기술

이 절은 본문을 읽는 데 필요한 사전 개념을 밑바닥부터 쌓습니다. 절차형 언어와 선언형 SQL의 차이에서 시작해, 트랜잭션과 커밋 경계, 커서, SQL 엔진과 PSM 실행기 사이의 전환 비용, 그리고 객체 의존성과 컴파일 상태로 이어집니다. 각 소절 끝에 본문의 어느 절에서 쓰이는지 적었고, 마지막 표로 연결을 정리했습니다.

### 선언형 SQL과 절차형 언어

**SQL(Structured Query Language)** 은 선언형 언어입니다. `SELECT name FROM emp WHERE dept_id = 10`처럼 "원하는 결과"만 적으면 옵티마이저가 읽는 방법을 정합니다. 반면 **절차형 언어(procedural language)** 는 "어떤 순서로 무엇을 할지"를 직접 적습니다. 요리에 비유하면 SQL은 "김치찌개 2인분 주세요"라는 주문이고, 절차형 언어는 "물 500ml를 끓이고, 김치를 넣고, 5분 뒤에 두부를 넣는다"는 조리법입니다.

SQL만으로는 "A 테이블을 조회해 조건에 따라 B 또는 C에 넣고, 실패하면 로그를 남기고 되돌린다" 같은 흐름을 표현하기 어렵습니다. 이런 흐름을 서버 안에서 하나의 단위로 실행하도록 만든 것이 저장 프로시저입니다. 이 구분은 아래 「tbPSM 블록의 구조」 절에서 DECLARE·BEGIN·EXCEPTION 구성으로, 「행 단위 처리와 집합 처리」 절에서 선언형으로 풀 수 있는 일을 절차형으로 풀면 생기는 비용으로 쓰입니다.

### 트랜잭션과 커밋 경계

**트랜잭션(transaction)** 은 "모두 성공하거나 모두 취소되어야 하는" 작업의 묶음입니다. 계좌 이체에서 출금과 입금이 둘 다 반영되거나 둘 다 취소되어야 하는 것이 대표적입니다. `COMMIT`은 지금까지의 변경을 확정하고, `ROLLBACK`은 마지막 커밋 이후의 변경을 되돌립니다. 중간 지점까지만 되돌리고 싶을 때는 `SAVEPOINT`로 표시를 해 두고 그 지점까지만 `ROLLBACK TO`를 합니다.

프로시저 안에서 `COMMIT`을 호출하면 그 프로시저를 부른 쪽의 트랜잭션까지 함께 확정됩니다. 호출한 애플리케이션이 "프로시저 호출 뒤 다른 작업까지 한 트랜잭션으로 묶겠다"고 생각했다면 의도와 다르게 동작합니다. 이 개념은 아래 「예외 처리와 트랜잭션 경계」 절에서 롤백 책임을 누가 지는지 정하는 기준으로, 「업무 예시: 정산 배치 프로시저」 절에서 커밋 간격을 정하는 데 쓰입니다.

### 커서: 결과 집합을 한 행씩 읽는 손잡이

SQL은 한 번에 여러 행을 반환하지만 절차형 언어의 변수는 한 번에 한 값만 담습니다. **커서(cursor)** 는 질의 결과 집합을 가리키는 포인터로, 한 행씩 꺼내서(`FETCH`) 변수에 담아 처리하게 해 줍니다. 책에서 손가락으로 줄을 짚어 가며 읽는 모습과 비슷합니다. 커서를 열고(`OPEN`), 행을 가져오고(`FETCH`), 닫는(`CLOSE`) 과정이 기본이며, `FOR ... LOOP` 구문은 이 과정을 자동으로 해 줍니다.

커서는 편리하지만 "한 행씩"이라는 성격 때문에 대량 처리에서 비용이 커집니다. 이 개념은 아래 「커서와 FOR 루프」 절에서 문법으로, 「BULK COLLECT와 FORALL로 전환 줄이기」 절에서 한 행씩 읽는 방식의 대안으로 쓰입니다.

### SQL 엔진과 PSM 실행기 사이의 전환

프로시저 안에는 두 종류의 문장이 섞여 있습니다. `IF`, `LOOP`, 변수 대입 같은 절차형 문장은 **PSM 실행기**가 처리하고, `SELECT`, `INSERT`, `UPDATE` 같은 SQL 문장은 **SQL 엔진**이 처리합니다. 프로시저가 실행되다 SQL을 만나면 제어가 SQL 엔진으로 넘어갔다가 결과와 함께 돌아옵니다. 이를 **컨텍스트 전환(context switch)** 이라고 부릅니다. 한 번의 전환 비용은 작지만, 10만 번 반복하는 루프 안에서 SQL을 호출하면 전환도 10만 번 일어납니다.

이 구조를 알면 "왜 루프 안에서 한 건씩 `UPDATE`하면 느리고, 한 번의 `UPDATE`로 묶으면 빠른가"를 이해할 수 있습니다. 이 개념은 아래 「행 단위 처리와 집합 처리」 절에서 비용의 원인으로, 「BULK COLLECT와 FORALL로 전환 줄이기」 절에서 해법의 원리로 쓰입니다.

### 객체 의존성과 컴파일 상태

저장 프로시저는 테이블·뷰·시퀀스·다른 프로시저를 참조합니다. 참조 대상이 바뀌거나 삭제되면 프로시저는 **무효(INVALID)** 상태가 되고, 다시 컴파일해 유효(VALID)해져야 실행됩니다. 자동차 부품이 바뀌면 그 부품을 쓰는 다른 부품도 점검이 필요한 것과 같습니다. 컴파일 오류는 프로시저를 만드는 시점에 나타나기도 하고, 참조 객체가 나중에 바뀐 뒤 실행 시점에 나타나기도 합니다.

이 개념은 아래 「오류 진단과 무효 객체 점검」 절에서 어떤 뷰로 상태와 오류 메시지를 확인하는지로, 「배포와 변경 관리」 절에서 테이블 변경이 프로시저에 미치는 영향을 사전에 확인하는 기준으로 쓰입니다.

### 기반 개념과 본문 절의 연결 지도

| 기반 개념 | 쓰이는 본문 절 | 그 절에서의 역할 |
|---|---|---|
| 선언형 SQL과 절차형 언어 | tbPSM 블록의 구조 / 행 단위 처리와 집합 처리 | 블록 구성 이해와 선언형으로 풀 수 있는 일을 가려내는 기준 |
| 트랜잭션과 커밋 경계 | 예외 처리와 트랜잭션 경계 / 업무 예시: 정산 배치 프로시저 | 롤백 책임과 커밋 간격 결정 |
| 커서 | 커서와 FOR 루프 / BULK COLLECT와 FORALL로 전환 줄이기 | 한 행씩 읽는 문법과 그 대안 |
| SQL 엔진과 PSM 실행기 전환 | 행 단위 처리와 집합 처리 / BULK COLLECT와 FORALL로 전환 줄이기 | 루프 안 SQL이 느린 이유와 해법의 원리 |
| 객체 의존성과 컴파일 상태 | 오류 진단과 무효 객체 점검 / 배포와 변경 관리 | 무효 객체 확인과 변경 영향 분석 |

## tbPSM 블록의 구조

tbPSM 프로그램의 기본 단위는 **블록(block)** 입니다. 블록은 선언부(`DECLARE`), 실행부(`BEGIN ... END`), 예외 처리부(`EXCEPTION`)로 이루어지며, 실행부만 필수입니다. 앞서 기반 기술에서 본 절차형 언어의 조리법처럼, 선언부는 재료와 도구를 준비하는 곳이고 실행부는 실제 조리 순서, 예외 처리부는 문제가 생겼을 때의 대응 매뉴얼입니다.

다음은 직원의 급여를 인상하는 가장 단순한 저장 프로시저입니다. 테이블 이름과 컬럼은 설명을 위한 가정입니다.

```sql
CREATE OR REPLACE PROCEDURE raise_salary(
    p_emp_id  IN  NUMBER,
    p_rate    IN  NUMBER,
    p_new_sal OUT NUMBER
) IS
    v_old_sal  emp.salary%TYPE;
BEGIN
    SELECT salary INTO v_old_sal
      FROM emp
     WHERE emp_id = p_emp_id;

    p_new_sal := ROUND(v_old_sal * (1 + p_rate), 0);

    UPDATE emp
       SET salary = p_new_sal
     WHERE emp_id = p_emp_id;
END;
/
```

이 짧은 코드에 중요한 요소가 여럿 들어 있습니다. `CREATE OR REPLACE`는 같은 이름의 프로시저가 있으면 교체한다는 뜻이고, 파라미터의 `IN`은 입력, `OUT`은 호출자에게 값을 돌려주는 출력 방향입니다. `emp.salary%TYPE`은 "emp 테이블의 salary 컬럼과 같은 타입"을 뜻하며, 컬럼 타입이 바뀌어도 변수 선언을 고칠 필요가 없게 해 줍니다. `:=`는 대입, `SELECT ... INTO`는 조회 결과를 변수에 담는 문법입니다. 마지막 줄의 `/`는 tbSQL 같은 클라이언트에게 프로시저 정의가 끝났음을 알려 주는 구분자입니다.

호출은 다음과 같이 합니다. 출력 파라미터를 받으려면 변수를 선언하고 익명 블록에서 호출하는 방법이 흔합니다.

```sql
SET SERVEROUTPUT ON

DECLARE
    v_result NUMBER;
BEGIN
    raise_salary(1001, 0.05, v_result);
    DBMS_OUTPUT.PUT_LINE('new salary = ' || v_result);
    ROLLBACK;
END;
/
```

`SET SERVEROUTPUT ON`과 `DBMS_OUTPUT.PUT_LINE`은 화면에 문자열을 출력하는 디버깅용 도구입니다. 사용 가능 여부와 설정 방법은 클라이언트와 Tibero 버전에 따라 다를 수 있으므로 환경에서 확인해야 합니다. 위 예에서 마지막의 `ROLLBACK`은 연습 중에 실제 급여가 바뀌지 않도록 되돌리는 안전장치입니다. 연습은 운영이 아닌 격리된 개발 환경에서 해야 합니다.

프로시저와 비슷한 단위로 **함수(function)** 가 있습니다. 함수는 값을 하나 반환(`RETURN`)한다는 점이 다르며, SQL 문장 안에서 호출할 수 있도록 설계할 수도 있습니다. 다만 SQL 안에서 함수를 부르면 행마다 PSM 실행기로 전환이 일어날 수 있으므로, 대량 조회에서 함수 호출이 성능에 미치는 영향을 신중히 살펴야 합니다. 이 내용은 아래 「행 단위 처리와 집합 처리」 절에서 다시 다룹니다.

| 구분 | 프로시저(Procedure) | 함수(Function) | 패키지(Package) |
|---|---|---|---|
| 반환값 | OUT 파라미터로 여러 개 가능 | RETURN으로 하나 | 포함된 프로시저·함수에 따름 |
| SQL 안 호출 | 불가(CALL 또는 블록에서 실행) | 조건을 만족하면 가능 | 포함된 함수를 통해 가능 |
| 주 용도 | 업무 처리 단위 | 계산·변환 | 관련 기능을 묶어 이름 공간·상태 관리 |
| 변경 영향 | 해당 객체만 재컴파일 | 해당 객체와 호출자 | 명세와 본문 분리로 영향 범위 축소 |

## 변수·제어문·타입 선언 습관

tbPSM에서 변수는 선언부에서 이름과 타입을 정합니다. 앞서 본 `%TYPE` 외에 행 전체의 구조를 닮은 `%ROWTYPE`도 자주 씁니다. 컬럼이 많은 테이블을 변수 하나로 다룰 수 있어 편리합니다. 아래 예는 한 행을 읽어 조건에 따라 분기하는 코드입니다.

```sql
CREATE OR REPLACE PROCEDURE check_order_state(p_order_id IN NUMBER) IS
    v_order  orders%ROWTYPE;
BEGIN
    SELECT * INTO v_order FROM orders WHERE order_id = p_order_id;

    IF v_order.status = 'PAID' THEN
        DBMS_OUTPUT.PUT_LINE('결제 완료: ' || v_order.order_id);
    ELSIF v_order.status = 'CANCELED' THEN
        DBMS_OUTPUT.PUT_LINE('취소된 주문');
    ELSE
        DBMS_OUTPUT.PUT_LINE('처리 대기');
    END IF;
END;
/
```

습관 몇 가지가 코드의 안정성을 크게 좌우합니다. 첫째, 컬럼과 같은 타입은 `%TYPE`·`%ROWTYPE`으로 선언해 스키마 변경과 코드가 어긋나는 일을 줄입니다. 둘째, `SELECT *` 대신 필요한 컬럼만 명시하면 컬럼이 추가되어도 동작이 안정적입니다. 위 예의 `SELECT *`는 `%ROWTYPE`과 짝을 이루는 경우처럼 의도가 분명할 때만 씁니다. 셋째, 변수와 파라미터 이름이 컬럼 이름과 같으면 SQL 안에서 어느 쪽인지 혼동해 의도하지 않은 동작이 생길 수 있으므로, 파라미터는 `p_`, 지역 변수는 `v_` 같은 접두어 규칙을 둡니다.

`NULL` 처리도 자주 문제가 됩니다. SQL의 `NULL`은 "값이 없음"이라 `NULL = NULL`의 결과가 참이 아닙니다. `IF v_status = NULL`은 항상 참이 되지 않으므로 `IF v_status IS NULL`로 써야 합니다. 숫자 계산에서 `NULL`이 하나라도 섞이면 결과가 `NULL`이 되므로, 필요한 곳에는 `NVL(값, 대체값)` 같은 함수로 기본값을 줍니다. 이런 세부는 단위 테스트에서 `NULL` 입력 사례를 꼭 포함해 확인하는 것이 좋습니다.

## 예외 처리와 트랜잭션 경계

실행 중 오류가 발생하면 정상 흐름은 멈추고 제어가 `EXCEPTION` 블록으로 넘어갑니다. 앞서 기반 기술에서 본 트랜잭션 개념에 비추어 보면, 예외 처리의 핵심 질문은 "오류가 났을 때 이 프로시저가 어디까지 되돌릴 책임을 지는가"입니다. 아래는 이전 예제에 예외 처리를 더한 것입니다.

```sql
CREATE OR REPLACE PROCEDURE raise_salary_safe(
    p_emp_id  IN  NUMBER,
    p_rate    IN  NUMBER,
    p_new_sal OUT NUMBER
) IS
    v_old_sal  emp.salary%TYPE;
    e_bad_rate EXCEPTION;
BEGIN
    IF p_rate IS NULL OR p_rate < 0 OR p_rate > 0.5 THEN
        RAISE e_bad_rate;
    END IF;

    SELECT salary INTO v_old_sal FROM emp WHERE emp_id = p_emp_id;

    p_new_sal := ROUND(v_old_sal * (1 + p_rate), 0);
    UPDATE emp SET salary = p_new_sal WHERE emp_id = p_emp_id;

EXCEPTION
    WHEN e_bad_rate THEN
        RAISE_APPLICATION_ERROR(-20001, '인상률이 허용 범위를 벗어났습니다: ' || p_rate);
    WHEN NO_DATA_FOUND THEN
        RAISE_APPLICATION_ERROR(-20002, '직원이 없습니다: ' || p_emp_id);
    WHEN OTHERS THEN
        RAISE;
END;
/
```

이 코드에는 세 가지 설계 선택이 들어 있습니다. 먼저 `e_bad_rate`처럼 **사용자 정의 예외**를 선언하고 `RAISE`로 발생시켜 업무 규칙 위반을 구분합니다. 다음으로 `NO_DATA_FOUND`는 `SELECT ... INTO`가 0건을 반환할 때 발생하는 **미리 정의된 예외**입니다. 반환 건수가 2건 이상이면 `TOO_MANY_ROWS`가 발생하므로, 기본 키로 조회할 때처럼 한 건이 보장되는 경우에만 `SELECT ... INTO`를 쓰는 것이 좋습니다. 마지막으로 `RAISE_APPLICATION_ERROR`는 -20000에서 -20999 범위의 사용자 정의 오류 번호와 메시지를 호출자에게 전달합니다. 이 범위는 Oracle PL/SQL 관례이며 Tibero에서의 지원은 사용 버전의 문서로 확인해야 합니다.

가장 위험한 안티패턴은 `WHEN OTHERS THEN NULL;`처럼 모든 예외를 삼키는 코드입니다. 오류를 숨기면 호출자는 성공했다고 믿고 후속 처리를 진행하고, 데이터는 일부만 반영된 불일치 상태가 됩니다. `OTHERS`를 쓴다면 오류 내용을 기록하고 `RAISE`로 다시 던지는 것이 원칙입니다. 로그를 남길 때는 오류 코드(`SQLCODE`), 메시지(`SQLERRM`), 입력 파라미터 중 식별에 필요한 값을 담되, 개인정보나 비밀번호는 로그에 넣지 않습니다.

트랜잭션 경계에서는 책임을 분명히 정하는 것이 중요합니다. 흔히 쓰는 원칙은 "하위 프로시저는 커밋하지 않고, 최상위 호출자(애플리케이션 또는 배치 진입점)가 커밋과 롤백을 결정한다"입니다. 하위 프로시저가 마음대로 `COMMIT`하면 상위 호출자가 "하나라도 실패하면 전체 취소"를 원해도 이미 확정된 부분은 되돌릴 수 없습니다. 반대로 대량 배치에서는 일정 건수마다 커밋해 언두(undo) 공간과 락 점유 시간을 줄이는 설계가 필요하기도 하므로, 어느 계층이 커밋 책임을 지는지를 프로시저 주석과 설계 문서에 명시합니다.

부분 실패를 허용하는 처리에는 `SAVEPOINT`가 유용합니다. 아래는 여러 건을 처리하면서 한 건이 실패해도 나머지를 계속 진행하는 패턴입니다.

```sql
FOR r IN (SELECT order_id FROM pending_orders) LOOP
    SAVEPOINT before_one;
    BEGIN
        process_order(r.order_id);
    EXCEPTION
        WHEN OTHERS THEN
            ROLLBACK TO before_one;
            INSERT INTO order_error_log(order_id, err_code, err_msg, logged_at)
            VALUES (r.order_id, SQLCODE, SUBSTR(SQLERRM, 1, 400), SYSDATE);
    END;
END LOOP;
```

바깥 블록과 별개로 안쪽 `BEGIN ... EXCEPTION ... END` 블록을 두면, 한 건의 오류가 전체 루프를 중단시키지 않습니다. 실패 건은 해당 시점까지만 되돌리고 오류 로그에 기록한 뒤 다음 건으로 넘어갑니다. 다만 이런 패턴이 있어도 실패 건을 사후에 반드시 점검해야 합니다. 오류 로그에 쌓이기만 하고 아무도 보지 않으면 `WHEN OTHERS THEN NULL`과 사실상 같은 효과를 냅니다.

## 커서와 FOR 루프

앞서 기반 기술에서 본 커서는 명시적으로 열고 닫는 방식과 `FOR` 루프로 자동 처리하는 방식이 있습니다. 가장 간단하고 안전한 방식은 `FOR` 루프입니다. 커서의 열기·가져오기·닫기를 자동으로 처리하므로 닫는 것을 잊는 실수가 없습니다.

```sql
CREATE OR REPLACE PROCEDURE print_dept_members(p_dept_id IN NUMBER) IS
    CURSOR c_emp IS
        SELECT emp_id, emp_name, salary
          FROM emp
         WHERE dept_id = p_dept_id
         ORDER BY emp_id;
BEGIN
    FOR r IN c_emp LOOP
        DBMS_OUTPUT.PUT_LINE(r.emp_id || ' ' || r.emp_name || ' ' || r.salary);
    END LOOP;
END;
/
```

명시적 커서는 처리 도중 조건에 따라 중단하거나 상태를 확인해야 할 때 씁니다. 커서의 상태 속성인 `%FOUND`, `%NOTFOUND`, `%ROWCOUNT`, `%ISOPEN`으로 가져온 결과를 확인합니다.

```sql
DECLARE
    CURSOR c IS SELECT emp_id, salary FROM emp WHERE dept_id = 10;
    v_id   emp.emp_id%TYPE;
    v_sal  emp.salary%TYPE;
BEGIN
    OPEN c;
    LOOP
        FETCH c INTO v_id, v_sal;
        EXIT WHEN c%NOTFOUND;
        -- 한 행 처리
    END LOOP;
    CLOSE c;
END;
/
```

명시적으로 열었다면 반드시 닫아야 합니다. 열린 커서가 쌓이면 세션당 열 수 있는 커서 한도(`OPEN_CURSORS`류의 파라미터 이름과 기본값은 버전에 따라 다를 수 있음)를 넘어 오류가 날 수 있습니다. 예외가 발생해도 닫히도록 `EXCEPTION` 블록에서 `IF c%ISOPEN THEN CLOSE c; END IF;`를 처리하거나, 자동으로 닫아 주는 `FOR` 루프를 우선 사용하는 편이 안전합니다.

커서가 조회하는 행을 갱신하려면 `SELECT ... FOR UPDATE`로 락을 거는 방법이 있습니다. 이 방식은 읽은 행을 다른 세션이 변경하지 못하게 막아 주는 대신, 락을 오래 잡으면 다른 세션이 대기합니다. 락 대기가 생기면 이전 글에서 다룬 Tibero 락 대기 진단 방법으로 점검할 수 있으며, 처리 건수가 많을 때는 락을 건 채 외부 호출을 하지 않도록 로직을 설계해야 합니다.

## 행 단위 처리와 집합 처리

앞서 기반 기술에서 본 SQL 엔진과 PSM 실행기 사이의 컨텍스트 전환을 떠올려 보겠습니다. 다음 코드는 "A 등급 고객의 포인트를 10% 올리는" 작업을 행 단위 루프로 구현한 것입니다.

```sql
-- 행 단위: 건수만큼 SQL 호출(컨텍스트 전환)이 발생한다
BEGIN
    FOR r IN (SELECT cust_id, point FROM customer WHERE grade = 'A') LOOP
        UPDATE customer
           SET point = r.point * 1.1
         WHERE cust_id = r.cust_id;
    END LOOP;
    COMMIT;
END;
/
```

같은 작업을 집합 SQL 한 문장으로 쓰면 다음과 같습니다.

```sql
-- 집합 처리: 한 번의 SQL로 전체 갱신
UPDATE customer
   SET point = point * 1.1
 WHERE grade = 'A';
COMMIT;
```

두 코드의 결과는 같지만 실행 방식이 다릅니다. 앞의 코드는 대상이 10만 건이면 `UPDATE`를 10만 번 실행하고 그때마다 SQL 엔진을 왕복합니다. 뒤의 코드는 SQL 엔진에 한 번만 요청하고, 옵티마이저가 내부에서 최적의 방식으로 갱신합니다. 일반적으로 알려진 원칙은 "SQL 한 문장으로 표현할 수 있으면 루프로 풀지 않는다"입니다. 다만 얼마나 차이가 나는지는 데이터 양, 인덱스, 환경에 따라 달라지므로 직접 측정해 확인해야 합니다.

아래 그림은 프로시저 실행 구조와 이 전환 비용의 위치를 도식으로 보여 줍니다.

<figure class="article-figure"><img src="{{ '/assets/images/tibero-tbpsm-execution-flow.svg' | relative_url }}" alt="클라이언트의 CALL이 서버의 PSM 실행기에서 DECLARE, BEGIN, EXCEPTION 구조로 처리되고 SQL 문장은 SQL 엔진으로 전환되는 흐름도"><figcaption>그림. tbPSM 저장 프로시저 호출과 SQL 엔진 전환. 이미지 출처: 직접 제작</figcaption></figure>

집합 처리로 풀기 어려운 경우도 있습니다. 행마다 복잡한 조건 분기가 있거나, 행별로 외부 프로시저를 호출해야 하거나, 실패한 행만 따로 기록해야 하는 경우입니다. 이때도 대부분은 `CASE` 표현식, `MERGE`, 윈도 함수 등으로 집합 SQL에 가깝게 풀 수 있는지 먼저 검토합니다. 아래는 조건 분기를 `CASE`로 집합 처리한 예입니다.

```sql
UPDATE customer
   SET point = CASE grade
                 WHEN 'A' THEN point * 1.10
                 WHEN 'B' THEN point * 1.05
                 ELSE point
               END
 WHERE grade IN ('A', 'B');
```

SQL 안에서 사용자 정의 함수를 호출하는 것도 같은 문제를 일으킵니다. `SELECT calc_fee(amount) FROM payment`처럼 행마다 함수를 부르면 건수만큼 PSM 실행기로 전환됩니다. 함수 로직이 단순한 계산이라면 SQL 표현식으로 풀어 쓰는 것이 낫고, 꼭 함수가 필요하다면 호출 건수와 응답 시간을 실행 계획과 실행 통계로 점검합니다. 이전에 다룬 Tibero 실행 계획 읽기 방법을 병행하면 어디에서 시간이 쓰이는지 파악하기 쉽습니다.

| 기준 | 행 단위 루프 | 집합 SQL | BULK 처리(다음 절) |
|---|---|---|---|
| 전환 횟수 | 건수만큼 | 1회 | 배치 수만큼 |
| 코드 복잡도 | 직관적, 길어짐 | 간결하나 복잡한 분기는 어려움 | 중간 |
| 행별 예외 처리 | 쉬움 | 어려움(전체 실패) | 가능(옵션 필요) |
| 적합한 경우 | 건수가 적거나 행마다 외부 효과가 있을 때 | 규칙을 SQL로 표현 가능할 때 | 행 단위가 불가피하나 건수가 많을 때 |

## BULK COLLECT와 FORALL로 전환 줄이기

행 단위 처리가 불가피한데 건수가 많다면, 전환 횟수를 줄이는 **BULK 처리**를 검토합니다. `BULK COLLECT`는 조회 결과를 한 번에 컬렉션(배열 비슷한 변수)에 담아 오고, `FORALL`은 컬렉션의 값을 사용해 DML(데이터 변경 SQL)을 한 번의 요청으로 보냅니다. 앞서 기반 기술에서 본 전환 비용을 "한 건씩 10만 번"에서 "천 건씩 100번" 같은 형태로 낮추는 방식입니다.

```sql
DECLARE
    TYPE t_ids IS TABLE OF customer.cust_id%TYPE;
    TYPE t_pts IS TABLE OF customer.point%TYPE;
    v_ids t_ids;
    v_pts t_pts;
    CURSOR c IS SELECT cust_id, point FROM customer WHERE grade = 'A';
    c_limit CONSTANT PLS_INTEGER := 1000;
BEGIN
    OPEN c;
    LOOP
        FETCH c BULK COLLECT INTO v_ids, v_pts LIMIT c_limit;
        EXIT WHEN v_ids.COUNT = 0;

        FOR i IN 1 .. v_ids.COUNT LOOP
            v_pts(i) := v_pts(i) * 1.1;
        END LOOP;

        FORALL i IN 1 .. v_ids.COUNT
            UPDATE customer SET point = v_pts(i) WHERE cust_id = v_ids(i);

        COMMIT;
    END LOOP;
    CLOSE c;
END;
/
```

핵심은 `LIMIT`입니다. 결과 전체를 한 번에 컬렉션에 담으면 서버 메모리를 크게 쓸 수 있으므로, 적절한 크기로 나누어 가져옵니다. 이 크기는 행의 폭과 가용 메모리, 동시 실행 수에 따라 달라 정답이 없으며, 보통 수백에서 수천 사이에서 시작해 직접 측정하며 조정합니다. 위 코드에서 `COMMIT`을 배치 안에서 호출한 것은 대량 변경의 언두 사용과 락 점유를 줄이려는 선택인데, 이 경우 중간에 실패하면 이미 커밋된 배치는 되돌릴 수 없으므로 재실행 가능한 설계(처리 완료 표시, 멱등성)가 필요합니다. 커서를 열어 둔 채 커밋하면 일부 환경에서 일관성 문제나 오류(예: 읽기 일관성 관련 오류)가 생길 수 있으므로, 이 패턴을 쓸 때는 사용 버전의 동작을 확인해야 합니다.

`FORALL`은 단일 DML 문장만 반복하며, 도중 한 건이 오류를 내면 기본적으로 전체가 중단됩니다. 오류가 난 행만 건너뛰고 계속하려면 `SAVE EXCEPTIONS` 옵션을 사용하고, 나중에 `SQL%BULK_EXCEPTIONS`로 실패 행의 위치와 오류 코드를 확인하는 방식이 Oracle PL/SQL에서 알려져 있습니다. 이 옵션의 Tibero 지원 여부와 세부 동작은 사용하는 버전의 공식 문서로 확인해야 합니다. 어느 쪽이든 BULK 처리로 바꾼 뒤에는 결과 행 수를 비교해 같은 결과가 나오는지 검증하고, 실행 시간은 직접 측정한 값만 근거로 삼습니다.

## 업무 예시: 정산 배치 프로시저

가정 시나리오로 하루 한 번 실행되는 "일 정산" 프로시저를 설계해 보겠습니다. 이 예시는 설명을 위한 가상 업무이며 실제 서비스의 규칙이 아닙니다. 요구사항은 "전날 승인된 결제를 가맹점별로 합산해 정산 테이블에 기록하고, 처리한 결제에는 정산 완료 표시를 남긴다. 중간에 실패하면 다시 실행해도 중복 정산이 없어야 한다"입니다.

먼저 집합 SQL로 풀 수 있는지 검토합니다. 가맹점별 합계는 `GROUP BY` 한 문장이면 됩니다. 중복 정산 방지는 "정산 완료 표시"와 "정산 대상 선택"을 같은 트랜잭션에서 처리하는 것으로 풀 수 있습니다. 설계는 다음과 같이 나눕니다.

```sql
CREATE OR REPLACE PROCEDURE settle_daily(p_target_date IN DATE) IS
    v_start  DATE := TRUNC(p_target_date);
    v_end    DATE := TRUNC(p_target_date) + 1;
    v_cnt    NUMBER;
BEGIN
    -- 1) 이미 같은 날짜가 정산되었는지 확인(재실행 시 중복 방지)
    SELECT COUNT(*) INTO v_cnt
      FROM settlement
     WHERE settle_date = v_start;

    IF v_cnt > 0 THEN
        RAISE_APPLICATION_ERROR(-20010, '이미 정산된 날짜입니다: '
                                         || TO_CHAR(v_start, 'YYYY-MM-DD'));
    END IF;

    -- 2) 집합 처리로 가맹점별 합계 기록
    INSERT INTO settlement(settle_date, merchant_id, total_amount, pay_count)
    SELECT v_start, merchant_id, SUM(amount), COUNT(*)
      FROM payment
     WHERE status = 'APPROVED'
       AND approved_at >= v_start
       AND approved_at <  v_end
       AND settled_flag = 'N'
     GROUP BY merchant_id;

    -- 3) 같은 조건의 결제에 정산 완료 표시
    UPDATE payment
       SET settled_flag = 'Y'
     WHERE status = 'APPROVED'
       AND approved_at >= v_start
       AND approved_at <  v_end
       AND settled_flag = 'N';

    -- 커밋은 호출한 배치 진입점이 결정한다
EXCEPTION
    WHEN OTHERS THEN
        RAISE;
END;
/
```

설계 판단을 정리하면 다음과 같습니다. 합산과 표시는 같은 조건을 쓰는 두 개의 집합 SQL로 처리해 컨텍스트 전환을 최소화했습니다. 날짜 조건을 `>= v_start AND < v_end`의 반열린 구간으로 써서 시간 단위 경계 오류를 막고, 컬럼에 함수를 씌우지 않아 인덱스를 쓸 수 있게 했습니다. 중복 실행은 시작 시점의 확인으로 막되, 동시에 두 세션이 실행하면 둘 다 확인을 통과할 수 있으므로 실제로는 `settlement(settle_date, merchant_id)`에 유니크 제약을 두는 것이 더 확실합니다. 커밋은 프로시저 안에서 하지 않고 호출한 배치 진입점이 결정하도록 해 실패 시 전체를 롤백할 수 있게 했습니다.

데이터가 매우 커서 단일 트랜잭션이 부담스럽다면, 날짜를 가맹점 범위나 시간 구간으로 쪼개 여러 번 호출하고 각 호출 사이에 커밋하는 설계로 바꿉니다. 이 경우 "어디까지 처리했는지"를 기록하는 진행 테이블이 필요하고, 실패 후 재실행이 이어서 처리되도록 만들어야 합니다. 성능 목표는 직접 측정한 뒤 정하며, 위 설계가 특정 규모에서 충분하다고 단정하지 않습니다.

## 패키지로 묶어 관리하기

관련된 프로시저와 함수를 하나로 묶는 단위가 **패키지(package)** 입니다. 패키지는 **명세(specification)** 와 **본문(body)** 으로 나뉩니다. 명세는 외부에서 호출할 수 있는 이름과 시그니처만 공개하고, 본문은 구현을 담습니다. 건물로 비유하면 명세는 안내 데스크의 층별 안내판이고, 본문은 각 층의 실제 내부 구조입니다.

```sql
CREATE OR REPLACE PACKAGE pkg_order AS
    PROCEDURE cancel_order(p_order_id IN NUMBER);
    FUNCTION  calc_refund(p_order_id IN NUMBER) RETURN NUMBER;
END pkg_order;
/

CREATE OR REPLACE PACKAGE BODY pkg_order AS
    -- 외부에 공개하지 않는 내부 함수
    FUNCTION is_cancelable(p_order_id IN NUMBER) RETURN BOOLEAN IS
        v_status orders.status%TYPE;
    BEGIN
        SELECT status INTO v_status FROM orders WHERE order_id = p_order_id;
        RETURN v_status IN ('PAID', 'READY');
    END;

    FUNCTION calc_refund(p_order_id IN NUMBER) RETURN NUMBER IS
        v_amt orders.amount%TYPE;
    BEGIN
        SELECT amount INTO v_amt FROM orders WHERE order_id = p_order_id;
        RETURN v_amt;
    END;

    PROCEDURE cancel_order(p_order_id IN NUMBER) IS
    BEGIN
        IF NOT is_cancelable(p_order_id) THEN
            RAISE_APPLICATION_ERROR(-20020, '취소할 수 없는 상태입니다');
        END IF;
        UPDATE orders SET status = 'CANCELED' WHERE order_id = p_order_id;
    END;
END pkg_order;
/
```

패키지의 장점은 첫째 이름 공간을 정리해 관련 기능을 한 곳에서 찾게 한다는 점입니다. 둘째 **명세와 본문의 분리** 덕분에, 본문 구현만 바꾸면 명세를 참조하는 다른 객체는 다시 컴파일되지 않거나 영향이 줄어듭니다. 이는 앞서 기반 기술에서 본 의존성과 컴파일 상태 때문에 중요합니다. 셋째, 명세에 없는 내부 함수는 외부에서 호출할 수 없어 구현을 감출 수 있습니다. 반면 패키지 변수에 세션별 상태를 저장하는 방식은 커넥션 풀 환경에서 예기치 않은 상태 공유를 일으킬 수 있으므로, 상태를 저장하는 패키지 변수는 신중히 설계합니다.

## 동적 SQL을 쓸 때의 주의

컴파일 시점에 SQL이 정해지지 않고 실행 시점에 문자열로 조립되는 경우를 **동적 SQL(dynamic SQL)** 이라고 하며, `EXECUTE IMMEDIATE`로 실행합니다. 테이블 이름이 파라미터로 바뀌는 관리용 작업이나 DDL 실행에 쓰입니다.

```sql
-- 위험: 입력값을 문자열에 직접 붙이면 SQL 인젝션 위험
EXECUTE IMMEDIATE 'DELETE FROM orders WHERE customer_id = ''' || p_cust || '''';

-- 권장: 바인드 변수로 값 전달
EXECUTE IMMEDIATE 'DELETE FROM orders WHERE customer_id = :1' USING p_cust;
```

값은 항상 바인드 변수로 전달해 SQL 인젝션(입력값이 SQL 구문으로 해석되어 의도하지 않은 명령이 실행되는 공격)을 막습니다. 바인드 변수는 같은 구조의 SQL을 재사용해 파싱 비용을 줄이는 효과도 있습니다. 테이블·컬럼 이름처럼 바인드가 불가능한 식별자는 허용 목록(화이트리스트)으로 검증한 뒤에만 조립합니다. 사용자 입력을 식별자에 그대로 쓰는 코드는 코드 리뷰에서 반드시 걸러야 합니다. 또한 동적 SQL은 컴파일 시점에 오류를 잡지 못하므로, 정적 SQL로 쓸 수 있는 곳에는 정적 SQL을 우선합니다.

## 오류 진단과 무효 객체 점검

프로시저를 배포한 뒤 "컴파일은 됐는데 경고가 있다" 또는 "어제까지 되던 프로시저가 오늘 실행되지 않는다"는 문제가 생기면, 앞서 기반 기술에서 본 객체 상태를 확인합니다. 다음 쿼리는 현재 사용자 소유의 무효 객체를 찾는 방법입니다. 뷰 이름과 컬럼은 Oracle 호환 딕셔너리 뷰를 기준으로 한 가정이며, Tibero 버전에서 제공하는 뷰를 확인해야 합니다.

```sql
SELECT object_type, object_name, status, last_ddl_time
  FROM user_objects
 WHERE status = 'INVALID'
 ORDER BY object_type, object_name;
```

무효 객체가 발견되면 컴파일 오류 메시지를 확인합니다.

```sql
SELECT name, type, line, position, text
  FROM user_errors
 ORDER BY name, type, sequence;
```

오류 위치의 줄 번호로 소스를 다시 확인하려면 소스 뷰를 조회합니다.

```sql
SELECT line, text
  FROM user_source
 WHERE name = 'RAISE_SALARY_SAFE'
   AND type = 'PROCEDURE'
 ORDER BY line;
```

테이블 컬럼을 바꾸기 전에는 그 테이블을 참조하는 프로시저가 어떤 것인지 의존성 뷰로 확인합니다. 이 쿼리를 변경 전 점검 절차에 넣으면 영향 범위를 놓치지 않습니다.

```sql
SELECT name, type, referenced_name, referenced_type
  FROM user_dependencies
 WHERE referenced_name = 'EMP'
 ORDER BY type, name;
```

점검 결과에 대한 해석 기준은 다음과 같습니다. `status`가 `INVALID`이면 먼저 재컴파일을 시도합니다. 재컴파일해도 오류가 남으면 `user_errors`의 메시지를 읽고 원인(참조 객체 삭제, 컬럼 이름 변경, 권한 부족)을 구분합니다. 권한 문제는 프로시저 소유자가 참조 객체에 대한 직접 권한을 가지고 있는지(롤을 통한 권한은 저장 프로시저에서 인정되지 않는 것이 Oracle의 알려진 동작이며, Tibero에서의 동작은 문서로 확인)를 점검합니다. 재컴파일은 다음처럼 합니다.

```sql
ALTER PROCEDURE raise_salary_safe COMPILE;
ALTER PACKAGE pkg_order COMPILE BODY;
```

운영 점검은 위 진단을 정기 작업으로 만들면 도움이 됩니다. 배포 직후 무효 객체 수가 0인지 확인하고, 변경 전후의 무효 객체 목록을 비교하며, 오류 로그 테이블에 쌓인 건수를 주기적으로 확인합니다. 무효 객체는 호출되는 순간 자동 재컴파일을 시도하는 경우가 있지만, 서비스 시간에 처음 호출될 때 컴파일이 일어나면 지연이나 오류가 생길 수 있으므로 배포 직후 선제적으로 컴파일해 두는 편이 안전합니다.

## 배포와 변경 관리

저장 프로시저는 애플리케이션 코드와 같은 소스 관리 대상이어야 합니다. 데이터베이스에 직접 접속해 수정하면 변경 이력이 남지 않고 환경 간 불일치가 생깁니다. 프로시저 소스를 파일로 저장소에 두고, 배포 스크립트가 순서대로 실행하게 하며, 같은 파일을 개발·검증·운영 환경에 적용하는 방식이 기본입니다. 배포 순서는 의존성에 따라 테이블 → 패키지 명세 → 패키지 본문 → 프로시저 순으로 정합니다.

배포 전 점검 목록을 만들어 두면 사고를 줄일 수 있습니다. 변경한 프로시저의 파라미터가 바뀌면 호출하는 쪽도 함께 바꾸고 배포 순서를 정합니다. 컬럼을 삭제하거나 이름을 바꾸는 DDL은 위 의존성 조회로 영향 객체를 확인한 뒤 진행합니다. 기존 데이터에 영향을 주는 로직 변경은 개발 환경에서 같은 입력으로 이전·이후의 결과를 비교합니다. 롤백 계획으로는 이전 버전의 소스를 보관하고 되돌리는 스크립트를 준비합니다. 이 목록의 항목은 직접 수행한 경험이 아니라 일반적인 변경 관리 원칙이며, 조직의 절차에 맞게 조정해야 합니다.

테스트는 프로시저를 호출하는 SQL 스크립트로 자동화할 수 있습니다. 정상 입력, 경계값, `NULL` 입력, 존재하지 않는 키, 권한 없는 사용자 호출 같은 사례를 정해 두고 기대 결과를 비교합니다. 테스트 데이터는 앞서 다룬 테스트 데이터 관리 원칙처럼 개인정보를 마스킹하고, 각 테스트가 끝나면 `ROLLBACK`으로 상태를 되돌려 서로 영향을 주지 않게 합니다.

## 보안과 권한

저장 프로시저는 소유자의 권한으로 실행되는 것이 일반적이며(정의자 권한, definer's rights), 이를 활용해 사용자에게 테이블 직접 권한 없이 프로시저 실행 권한만 주는 설계가 가능합니다. 예를 들어 일반 사용자는 `employee` 테이블을 직접 변경할 수 없지만, 검증 로직이 포함된 `raise_salary_safe`만 실행할 수 있게 하면 허용된 경로로만 변경하게 만들 수 있습니다. 실행 권한은 `GRANT EXECUTE ON raise_salary_safe TO app_user;` 형태로 부여하며, 구체 문법과 호출자 권한(invoker's rights) 지원 여부는 버전 문서로 확인합니다.

이 구조에서 주의할 점은 프로시저가 소유자의 강한 권한으로 동작하므로, 프로시저 자체에 취약점이 있으면 권한이 우회된다는 것입니다. 앞서 본 동적 SQL의 인젝션이 대표적입니다. 프로시저 소유 계정은 필요한 최소 권한만 갖게 하고, 입력 파라미터를 검증하며, 오류 메시지에 내부 구조(테이블 이름, SQL 문장)를 그대로 노출하지 않도록 합니다. 민감한 데이터를 다루는 프로시저는 실행 이력을 감사 로그에 남겨 누가 언제 호출했는지 추적할 수 있게 합니다.

## 한계와 적용 기준 Q&A

### Q. 프로시저 안의 로직을 애플리케이션으로 옮겨야 할 때는 언제인가요?

A. 로직이 자주 바뀌고 애플리케이션 팀이 테스트·배포를 주도하는 경우, 외부 시스템 호출이나 복잡한 분기가 많은 경우, 데이터베이스 부하가 병목이라 애플리케이션 서버에서 처리를 분산해야 하는 경우가 후보입니다. 반대로 대량 데이터를 한꺼번에 읽고 쓰는 배치, 여러 테이블을 한 트랜잭션으로 묶어야 하는 정합성 규칙은 프로시저의 장점이 큽니다. 어느 쪽이든 조직의 개발·운영 역량과 변경 빈도를 함께 고려해야 하며, 일률적인 정답은 없습니다.

### Q. Oracle PL/SQL 코드를 tbPSM으로 그대로 옮길 수 있나요?

A. 많은 구문이 비슷하다고 알려져 있지만 "그대로 된다"고 가정해서는 안 됩니다. 내장 패키지(`DBMS_*` 계열), 일부 데이터 타입, 힌트, 예외 처리 세부, 딕셔너리 뷰 컬럼이 다를 수 있습니다. 이전 작업이라면 객체별로 컴파일 결과와 실행 결과를 검증하고, 지원되지 않는 기능은 대체 방법을 찾는 과정이 필요합니다. 이 글에서 Oracle 동작을 언급한 부분도 Tibero에서 동일하다는 주장이 아니므로, 실제 사용 전 Tibero 공식 문서와 테스트 환경에서 확인해야 합니다.

### Q. 프로시저가 느릴 때 어디부터 보나요?

A. 먼저 프로시저 전체가 느린지, 특정 SQL이 느린지 구분합니다. 안의 SQL을 하나씩 떼어 실행 계획과 소요 시간을 확인하면 병목이 드러나는 경우가 많습니다. 다음으로 루프 안의 SQL 호출 건수, SQL 안의 함수 호출, 락 대기, 커밋 간격을 점검합니다. 병목이 SQL이라면 앞서 다룬 실행 계획과 통계 정보 관점으로, 락이라면 락 대기 진단 관점으로 접근합니다. 추측으로 코드를 고치기 전에 단계별 소요 시간을 직접 측정해 근거를 확보합니다.

### Q. 예외를 모두 잡아서 로그만 남기면 안전한가요?

A. 오히려 위험할 수 있습니다. 호출자에게 오류가 전달되지 않으면 업무가 성공한 것으로 처리되어 데이터 불일치가 조용히 쌓입니다. 복구 가능한 오류만 처리하고, 나머지는 로그를 남긴 뒤 다시 던져 호출자가 결정하게 하는 것이 원칙입니다. 로그만 남기는 경우에도 누군가 로그를 확인하고 조치하는 운영 절차가 함께 있어야 의미가 있습니다.

### Q. 프로시저 안에서 COMMIT을 해도 되나요?

A. 가능하지만 책임 계층을 정한 뒤에 합니다. 최상위 배치 프로시저처럼 호출 흐름의 끝에 있고 재실행 가능하게 설계된 경우에는 커밋을 두어도 됩니다. 다른 프로시저가 호출하는 하위 모듈에서는 커밋하지 않아 상위가 전체 롤백을 결정할 수 있게 하는 편이 안전합니다. 어느 쪽이든 커밋 정책을 주석과 설계 문서에 남깁니다.

### Q. 저장 프로시저 버전 관리는 어떻게 하나요?

A. 소스를 저장소에 두고 변경을 코드 리뷰와 배포 파이프라인으로 통과시키는 것이 기본입니다. 운영 데이터베이스에서 직접 수정한 내용은 곧바로 저장소에 반영하거나, 직접 수정 자체를 막는 정책이 필요합니다. 환경 간 객체 차이를 정기적으로 비교(예: 소스 뷰의 내용을 해시로 비교)하면 불일치를 일찍 발견할 수 있습니다.

## 정리

tbPSM은 데이터 가까이에서 일관되게 실행해야 하는 규칙을 서버에 저장하는 절차형 언어입니다. 설계의 핵심은 세 가지로 요약됩니다. 첫째, SQL 한 문장으로 풀 수 있는 일은 루프로 풀지 않고 집합 처리를 우선하며, 불가피하면 BULK 처리로 컨텍스트 전환을 줄입니다. 둘째, 예외는 삼키지 않고 기록한 뒤 다시 던지며, 트랜잭션 경계는 최상위 호출자가 책임지게 정합니다. 셋째, 무효 객체와 의존성을 정기적으로 진단하고 소스를 저장소에서 관리합니다.

처음에는 격리된 개발 환경에서 작은 프로시저 하나를 만들어 `user_errors`와 `user_dependencies`로 상태를 확인하는 흐름부터 익혀 보시기 바랍니다. 이후 실제 업무의 느린 루프 하나를 집합 SQL로 바꿔 보고, 전후 결과와 소요 시간을 직접 측정해 비교하면 이 글의 원칙이 실제로 어떻게 작동하는지 체감할 수 있습니다.

<h3 class="references-heading">참고 자료</h3>

- [TmaxTibero 기술 문서 포털](https://technet.tmaxsoft.com) — Tibero 제품 매뉴얼(tbPSM 안내서, SQL 참조서, 딕셔너리 뷰 등)의 공식 제공처. 버전별 지원 구문 확인에 사용
- [Oracle Database PL/SQL Language Reference 19c](https://docs.oracle.com/en/database/oracle/oracle-database/19/lnpls/index.html) — PL/SQL 블록·커서·패키지·컬렉션의 공식 레퍼런스. tbPSM 문법 이해의 배경 자료
- [Oracle PL/SQL Error Handling](https://docs.oracle.com/en/database/oracle/oracle-database/19/lnpls/plsql-error-handling.html) — 예외 선언·전파·처리와 RAISE_APPLICATION_ERROR에 대한 공식 설명
- [Oracle PL/SQL Optimization and Tuning](https://docs.oracle.com/en/database/oracle/oracle-database/19/lnpls/plsql-optimization-and-tuning.html) — BULK COLLECT, FORALL, 컨텍스트 전환 최소화 등 성능 지침
- [PostgreSQL Documentation, PL/pgSQL](https://www.postgresql.org/docs/current/plpgsql.html) — 다른 제품의 절차형 언어 설계와 비교해 볼 수 있는 공식 문서
- [Oracle Database SQL Language Reference, EXECUTE IMMEDIATE](https://docs.oracle.com/en/database/oracle/oracle-database/19/lnpls/EXECUTE-IMMEDIATE-statement.html) — 동적 SQL과 바인드 변수 사용에 대한 공식 설명
