export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Allow slightly longer subject lines than the default 72; easier for
    // refactors that include the file they touch.
    "subject-case": [0],
    "body-max-line-length": [0],
    "footer-max-line-length": [0],
  },
};
