// A player's name that shortens to first initial + last name ("S. Gilgeous-Alexander")
// while the table it's in is scrolled sideways (`data-scrolled` on an ancestor,
// set by StickyHeadTable). Screen readers always get the full name.
import styles from "./ScrollName.module.css";

export default function ScrollName({ firstName, lastName }: { firstName: string; lastName: string }) {
  const first = firstName.trim();
  const last = lastName.trim();
  if (!first || !last) return <>{`${first} ${last}`.trim()}</>;
  return (
    <>
      <span className={styles.sr}>{`${first} ${last}`}</span>
      <span aria-hidden="true">
        {first[0]}
        <span className={`${styles.fold} ${styles.rest}`}>
          <span>{first.slice(1)}</span>
        </span>
        <span className={`${styles.fold} ${styles.dot}`}>
          <span>.</span>
        </span>{" "}
        {last}
      </span>
    </>
  );
}
