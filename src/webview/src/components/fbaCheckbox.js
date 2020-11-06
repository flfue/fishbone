// copyright (c) 2020, Matthias Behr
import React from 'react';
import PropTypes from 'prop-types';
import Container from '@material-ui/core/Container';
import IconButton from '@material-ui/core/IconButton';
import EditIcon from '@material-ui/icons/Edit';
import FilterListIcon from '@material-ui/icons/FilterList';
import CheckBoxIcon from '@material-ui/icons/CheckBox';
import CheckBoxOutlineBlankIcon from '@material-ui/icons/CheckBoxOutlineBlank';
import ErrorIcon from '@material-ui/icons/Error';

import Dialog from '@material-ui/core/Dialog';
import DialogTitle from '@material-ui/core/DialogTitle';
import DialogActions from '@material-ui/core/DialogActions';
import DialogContent from '@material-ui/core/DialogContent';
import DialogContentText from '@material-ui/core/DialogContentText';
import Button from '@material-ui/core/Button';
import MuiAlert from '@material-ui/lab/Alert';
import { ButtonGroup, Snackbar, TextField } from '@material-ui/core';
import MultiStateBox from './multiStateBox';


// import Grid from '@material-ui/core/Grid';
// import Autocomplete from '@material-ui/lab/Autocomplete';
// import CircularProgress from '@material-ui/core/CircularProgress';
// import { sendAndReceiveMsg } from '../util';
// import jp from 'jsonpath'

// todo
//  - use Chips instead of texts (allowing always to set the <DoneIcon />?)
// - highlight current selection with a different text. e.g. "keep as OK", ...
// - add id= to buttons...
// - use e.g. react-markdown to support markdown for background, desc, comments

function Alert(props) {
    return <MuiAlert elevation={6} variant="filled" {...props} />;
}

export default function FBACheckbox(props) {

    const [editOpen, setEditOpen] = React.useState(false);
    const [applyFilterBarOpen, setApplyFilterBarOpen] = React.useState(false);

    // values that can be changed: (comments and value (ok/error...))
    const [values, setValues] = React.useState({ 'comments': props.comments, 'value': props.value });
    const handleValueChanges = e => {
        const { name, value } = e.target;
        setValues({ ...values, [name]: value })
    }

    const handleClickOpen = () => {
        setEditOpen(true);
    };

    const handleClose = (partValues) => {
        console.log(`handleClose values=`, values);
        console.log(`handleClose props=`, props);
        console.log(`handleClose partValues=`, partValues);
        setEditOpen(false);
        let newValues = { ...values };
        if (partValues) {
            newValues = { ...values, value: partValues.value };
            console.log(`handleClose newValues=`, newValues);
            setValues(newValues);
            console.log(`handleClose values=`, values);
            // todo investigate. I still dont understand the useState hooks...
            // values here is still unchanged...
        }
        // update values... todo (event) => props.onChange(event, 'comments')
        if ((newValues.comments !== props.comments) ||
            (newValues.value !== props.value)) {
            props.onChange({ target: { type: 'textfield', values: newValues } });
        }
    };

    const handleFilterBarClose = (event, reason) => {
        if (reason === 'clickaway') {
            return;
        }
        setApplyFilterBarOpen(false);
    }

    const backgroundFragments = props.backgroundDescription ? (
        <React.Fragment>
            <DialogContentText variant='h5'>Background</DialogContentText><DialogContentText paragraph>
                {props.backgroundDescription}
            </DialogContentText>
        </React.Fragment>
    ) : null;

    const instructionsFragment = props.instructions ? (
        <React.Fragment>
            <DialogContentText variant='h5'>Instructions</DialogContentText>
            <DialogContentText paragraph>
                {props.instructions}
            </DialogContentText>
        </React.Fragment>
    ) : null;

    return (
        <Container>
            <MultiStateBox values={[{ value: null, icon: <CheckBoxOutlineBlankIcon /> }, { value: 'ok', icon: <CheckBoxIcon /> }, { value: 'error', icon: <ErrorIcon />, color: 'secondary' }]} {...props} color="primary" />
            <IconButton aria-label="edit" onClick={handleClickOpen}>
                <EditIcon fontSize="small" />
            </IconButton>
            <Dialog open={editOpen} onClose={() => handleClose()} fullWidth={true} maxWidth='md'>
                <DialogTitle id={'form-edit-' + props.name} align='left' gutterBottom>Edit '{props.label}'</DialogTitle>
                <DialogContent>
                    {backgroundFragments}
                    {instructionsFragment}
                    <DialogContentText variant='h5'>Processing comments</DialogContentText>
                    <TextField name='comments' onChange={handleValueChanges} margin="dense" id={'comments-field-' + props.name} label='Comments' fullWidth multiline value={values.comments} />
                </DialogContent>
                <DialogActions>
                    <Button id={'apply-filter-' + props.name} color="primary" startIcon={<FilterListIcon />} onClick={() => setApplyFilterBarOpen(true)}>
                        Apply filter
                    </Button>
                    <Snackbar open={applyFilterBarOpen} autoHideDuration={6000} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} onClose={handleFilterBarClose}>
                        <Alert onClose={handleFilterBarClose} severity="info">
                            Filter applied on document '...dlt'
                        </Alert>
                    </Snackbar>
                    <ButtonGroup>
                        <Button size="small" onClick={() => { handleClose({ value: 'ok' }); }} color="primary" startIcon={<CheckBoxIcon />}>
                            {values.value === 'ok' ? 'keep as OK' : 'mark as OK'}
                        </Button>
                        <Button size="small" onClick={() => { handleClose({ value: 'error' }); }} color="secondary" startIcon={<ErrorIcon />}>
                            {values.value === 'error' ? 'keep as ERROR' : 'mark as ERROR'}
                        </Button>
                        <Button size="small" onClick={() => { handleClose({ value: null }); }} color="primary" startIcon={<CheckBoxOutlineBlankIcon />}>
                            {!values.value ? 'keep as unprocessed' : 'mark as unprocessed'}   
                        </Button>
                    </ButtonGroup>
                    <Button onClick={() => handleClose()} color="primary">
                        Close
                    </Button>
                </DialogActions>
            </Dialog>
        </Container >
    );
}

FBACheckbox.propTypes = {
    name: PropTypes.string.isRequired, // todo do we need the name? the label would be sufficient, or?
    label: PropTypes.string.isRequired,
    tooltip: PropTypes.string,
    onChange: PropTypes.func.isRequired // otherwise the option won't be stored
};